package documents

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
)

const (
	aliyunOCRHost    = "ocr-api.cn-hangzhou.aliyuncs.com"
	aliyunOCRVersion = "2021-07-07"
	maxOCRSize       = 10 * 1024 * 1024
)

var (
	nonAmountCharacters = regexp.MustCompile(`[^0-9.\-]`)
	dateNumbers         = regexp.MustCompile(`\d+`)
	rangeNumbers        = regexp.MustCompile(`\d+`)
)

type aliyunOCR struct {
	pool   *pgxpool.Pool
	client *http.Client
	now    func() time.Time
	nonce  func() string
}

func NewAliyunOCR(pool *pgxpool.Pool, client *http.Client) OCRRecognizer {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &aliyunOCR{
		pool: pool, client: client, now: time.Now,
		nonce: func() string {
			value := make([]byte, 16)
			if _, err := rand.Read(value); err != nil {
				return fmt.Sprintf("%d", time.Now().UnixNano())
			}
			return hex.EncodeToString(value)
		},
	}
}

func (o *aliyunOCR) Recognize(
	ctx context.Context, kind string, file fileplatform.File, content []byte,
) (map[string]any, error) {
	action := "RecognizeInvoice"
	allowed := map[string]bool{
		"image/png": true, "image/jpg": true, "image/jpeg": true,
		"image/bmp": true, "image/gif": true, "image/tiff": true, "image/webp": true,
		"application/pdf": true,
	}
	if kind == OCRBillTransaction {
		action = "RecognizeBankAcceptance"
		delete(allowed, "application/pdf")
	} else if kind != OCRVatInvoice {
		return nil, apierror.Validation("OCR 类型不合法",
			map[string][]string{"kind": {"不支持的 OCR 类型"}})
	}
	contentType := ""
	if file.ContentType != nil {
		contentType = strings.ToLower(strings.TrimSpace(*file.ContentType))
	}
	if !allowed[contentType] {
		return nil, apierror.Validation("OCR 文件不合法",
			map[string][]string{"fileId": {"不支持的文件格式"}})
	}
	if file.Size > maxOCRSize || len(content) > maxOCRSize {
		return nil, apierror.Validation("OCR 文件不合法",
			map[string][]string{"fileId": {"文件超过 10MB,请压缩后重试"}})
	}
	var accessKeyID, accessKeySecret string
	err := o.pool.QueryRow(ctx, `SELECT ocr_access_key_id,ocr_access_key_secret
		FROM acc_setting ORDER BY inserted_at LIMIT 1`).Scan(&accessKeyID, &accessKeySecret)
	if err != nil || strings.TrimSpace(accessKeyID) == "" ||
		strings.TrimSpace(accessKeySecret) == "" {
		return nil, apierror.Validation("OCR 未配置",
			map[string][]string{"fileId": {"未配置阿里云 OCR 凭证"}})
	}
	data, err := o.call(ctx, action, content, accessKeyID, accessKeySecret)
	if err != nil {
		return nil, err
	}
	if kind == OCRVatInvoice {
		return mapInvoiceOCR(data), nil
	}
	return mapAcceptanceOCR(data), nil
}

func (o *aliyunOCR) call(
	ctx context.Context, action string, body []byte, accessKeyID, accessKeySecret string,
) (map[string]any, error) {
	payloadHash := sha256Hex(body)
	headers := [][2]string{
		{"content-type", "application/octet-stream"},
		{"host", aliyunOCRHost},
		{"x-acs-action", action},
		{"x-acs-content-sha256", payloadHash},
		{"x-acs-date", o.now().UTC().Truncate(time.Second).Format(time.RFC3339)},
		{"x-acs-signature-nonce", o.nonce()},
		{"x-acs-version", aliyunOCRVersion},
	}
	signedNames := make([]string, 0, len(headers))
	var canonicalHeaders strings.Builder
	for _, header := range headers {
		signedNames = append(signedNames, header[0])
		canonicalHeaders.WriteString(header[0])
		canonicalHeaders.WriteByte(':')
		canonicalHeaders.WriteString(header[1])
		canonicalHeaders.WriteByte('\n')
	}
	signed := strings.Join(signedNames, ";")
	canonical := strings.Join([]string{
		http.MethodPost, "/", "", canonicalHeaders.String(), signed, payloadHash,
	}, "\n")
	stringToSign := "ACS3-HMAC-SHA256\n" + sha256Hex([]byte(canonical))
	mac := hmac.New(sha256.New, []byte(accessKeySecret))
	_, _ = mac.Write([]byte(stringToSign))
	signature := hex.EncodeToString(mac.Sum(nil))
	authorization := "ACS3-HMAC-SHA256 Credential=" + accessKeyID +
		",SignedHeaders=" + signed + ",Signature=" + signature

	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://"+aliyunOCRHost+"/", bytes.NewReader(body))
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "构造 OCR 请求失败", err)
	}
	for _, header := range headers {
		if header[0] != "host" {
			request.Header.Set(header[0], header[1])
		}
	}
	request.Header.Set("authorization", authorization)
	response, err := o.client.Do(request)
	if err != nil {
		return nil, apierror.Validation("阿里云 OCR 网络错误",
			map[string][]string{"fileId": {err.Error()}})
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
	if err != nil {
		return nil, apierror.Validation("读取阿里云 OCR 响应失败",
			map[string][]string{"fileId": {err.Error()}})
	}
	var envelope map[string]any
	if err = json.Unmarshal(raw, &envelope); err != nil {
		return nil, apierror.Validation("阿里云 OCR 响应不合法",
			map[string][]string{"fileId": {"无法解析响应"}})
	}
	if response.StatusCode != http.StatusOK {
		code, _ := envelope["Code"].(string)
		message, _ := envelope["Message"].(string)
		return nil, apierror.Validation("阿里云 OCR 调用失败",
			map[string][]string{"fileId": {strings.TrimSpace(code + ":" + message)}})
	}
	data, ok := envelope["Data"]
	if !ok {
		return nil, apierror.Validation("阿里云 OCR 响应不合法",
			map[string][]string{"fileId": {"返回缺少 Data 字段"}})
	}
	switch value := data.(type) {
	case map[string]any:
		return value, nil
	case string:
		var result map[string]any
		if err = json.Unmarshal([]byte(value), &result); err == nil {
			return result, nil
		}
	}
	return nil, apierror.Validation("阿里云 OCR 响应不合法",
		map[string][]string{"fileId": {"Data 无法解析"}})
}

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func nestedOCRData(input map[string]any) map[string]any {
	if value, ok := input["data"].(map[string]any); ok {
		return value
	}
	return input
}

func mapInvoiceOCR(input map[string]any) map[string]any {
	data := nestedOCRData(input)
	result := map[string]any{}
	putText(result, "invoiceCode", data["invoiceCode"])
	putText(result, "invoiceNo", data["invoiceNumber"])
	putDate(result, "invoiceDate", data["invoiceDate"])
	if kind := invoiceKind(textOCR(data["invoiceType"])); kind != "" {
		result["invoiceKind"] = kind
	}
	putText(result, "sellerName", data["sellerName"])
	putText(result, "sellerTaxNo", data["sellerTaxNumber"])
	putText(result, "sellerAddressPhone", data["sellerContactInfo"])
	putText(result, "sellerBankAccount", data["sellerBankAccountInfo"])
	putText(result, "buyerName", data["purchaserName"])
	putText(result, "buyerTaxNo", data["purchaserTaxNumber"])
	putText(result, "buyerAddressPhone", data["purchaserContactInfo"])
	putText(result, "buyerBankAccount", data["purchaserBankAccountInfo"])
	putAmount(result, "netTotal", data["invoiceAmountPreTax"])
	putAmount(result, "taxTotal", data["invoiceTax"])
	putAmount(result, "grossTotal", data["totalAmount"])
	putText(result, "issuer", data["drawer"])
	putText(result, "reviewer", data["reviewer"])
	putText(result, "payee", data["recipient"])
	putText(result, "remarks", data["remarks"])
	if rows, ok := data["invoiceDetails"].([]any); ok && len(rows) > 0 {
		items := make([]map[string]any, 0, len(rows))
		for _, raw := range rows {
			row, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			item := map[string]any{}
			putText(item, "name", row["itemName"])
			putText(item, "model", row["specification"])
			putText(item, "unit", row["unit"])
			putAmount(item, "quantity", row["quantity"])
			putAmount(item, "price", row["unitPrice"])
			putAmount(item, "net_amount", row["amount"])
			putText(item, "tax_rate", row["taxRate"])
			putAmount(item, "tax_amount", row["tax"])
			items = append(items, item)
		}
		result["items"] = items
	}
	return result
}

func mapAcceptanceOCR(input map[string]any) map[string]any {
	data := nestedOCRData(input)
	result := map[string]any{}
	putText(result, "bill_no", data["draftNumber"])
	putDate(result, "issue_date", data["issueDate"])
	putDate(result, "due_date", data["validToDate"])
	putDate(result, "acceptance_date", data["acceptanceDate"])
	if value := textOCR(data["assignability"]); value != "" {
		result["transferable"] = !strings.Contains(value, "不")
	}
	putText(result, "drawer_name", data["issuerName"])
	putText(result, "drawer_account", data["issuerAccountNumber"])
	putText(result, "drawer_bank_name", data["issuerAccountBank"])
	putText(result, "payee_name", data["payeeName"])
	putText(result, "payee_account", data["payeeAccountNumber"])
	putText(result, "payee_bank_name", data["payeeAccountBank"])
	putText(result, "acceptor_name", data["acceptorName"])
	putText(result, "acceptor_account", data["acceptorAccountNumber"])
	putText(result, "acceptor_bank_name", data["acceptorAccountBank"])
	putText(result, "acceptor_bank_no", data["acceptorBankNumber"])
	if len(result) > 0 {
		result["bill_kind"] = BillBankAcceptance
	}
	if start, end, ok := parseOCRRange(textOCR(data["subDraftNumber"])); ok {
		result["sub_start"], result["sub_end"] = start, end
		result["amount"] = decimal.NewFromInt(end - start + 1).Div(decimal.NewFromInt(100)).StringFixed(2)
	} else if amount := amountOCR(data["totalAmount"]); amount != "" {
		if value, err := decimal.NewFromString(amount); err == nil {
			cents := value.Mul(decimal.NewFromInt(100)).Round(0).IntPart()
			if cents >= 1 {
				result["sub_start"], result["sub_end"], result["amount"] = int64(1), cents, amount
			}
		}
	}
	return result
}

func textOCR(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func amountOCR(value any) string {
	switch item := value.(type) {
	case json.Number:
		return item.String()
	case float64:
		return strconv.FormatFloat(item, 'f', -1, 64)
	case string:
		return nonAmountCharacters.ReplaceAllString(item, "")
	default:
		return ""
	}
}

func dateOCR(value any) string {
	parts := dateNumbers.FindAllString(textOCR(value), -1)
	var year, month, day string
	switch {
	case len(parts) >= 3 && len(parts[0]) == 4:
		year, month, day = parts[0], parts[1], parts[2]
	case len(parts) == 1 && len(parts[0]) == 8:
		year, month, day = parts[0][:4], parts[0][4:6], parts[0][6:]
	default:
		return ""
	}
	parsed, err := time.Parse("2006-1-2", year+"-"+month+"-"+day)
	if err != nil {
		return ""
	}
	return parsed.Format("2006-01-02")
}

func invoiceKind(value string) string {
	if value == "" {
		return ""
	}
	special := strings.Contains(value, "专用")
	switch {
	case strings.Contains(value, "数电") && special:
		return InvoiceDigitalSpecial
	case strings.Contains(value, "数电"):
		return InvoiceDigitalNormal
	case strings.Contains(value, "电子") && special:
		return InvoiceElectronicSpecial
	case strings.Contains(value, "电子"):
		return InvoiceElectronicNormal
	case special:
		return InvoiceSpecial
	default:
		return InvoiceNormal
	}
}

func putText(target map[string]any, key string, value any) {
	if parsed := textOCR(value); parsed != "" {
		target[key] = parsed
	}
}

func putAmount(target map[string]any, key string, value any) {
	if parsed := amountOCR(value); parsed != "" {
		target[key] = parsed
	}
}

func putDate(target map[string]any, key string, value any) {
	if parsed := dateOCR(value); parsed != "" {
		target[key] = parsed
	}
}

func parseOCRRange(value string) (int64, int64, bool) {
	parts := rangeNumbers.FindAllString(value, -1)
	if len(parts) == 0 {
		return 0, 0, false
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 1 {
		return 0, 0, false
	}
	end := start
	if len(parts) > 1 {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || end < start {
			return 0, 0, false
		}
	}
	return start, end, true
}
