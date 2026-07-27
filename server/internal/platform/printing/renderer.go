package printing

// xlsx 模板填充引擎（打印/导出共用核心，移植自 Elixir SynieCore.Printing.Renderer，
// 决策见 docs/adr/2026-07-23-print-template.md 与 .scratch/print-engine/issues/01、02）。
//
// 原则：最小侵入 XML 操作——解包 zip、改写第一个 sheet 的 XML、重打包，其余 part
// 原样拷贝。含 ${...} 占位符的单元格统一改写为 inline string 落值（绕开
// sharedStrings 索引维护）；值一律按文本写入，显示格式由单元格自身 Excel 格式决定。
//
// 只处理工作簿第一个 sheet 作为模板体，其余 sheet 原样保留（render_sheets 除外，
// 导出以新 sheet 集替换模板 sheet）。
//
// 已知边界（由模板制作约定规避，与 Elixir 版一致）：
//   - 明细模板行不参与跨行合并单元格（跨明细行的 mergeCell 顺移结果未定义）
//   - 单元格公式（<f>）内的引用不随行复制/行顺移调整
//   - 批量打印时模板的 conditionalFormatting / autoFilter / dataValidation 等
//     只对首个模板块生效（mergeCells / rowBreaks / 打印区域按块复制）

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// PrintDoc 是单份单据的填充数据：头字段直取（含 company.name 这类路径键），
// Loops 按关系名给出各循环区行集；值均为字符串（空值归空串）。
type PrintDoc struct {
	Fields map[string]string
	Loops  map[string][]map[string]string
}

// NamedDoc 为导出用：sheet 名 + 单据数据。
type NamedDoc struct {
	Name string
	Doc  PrintDoc
}

// ErrEmptyDocs 表示没有可渲染的单据（服务层映射为中文校验错误）。
var ErrEmptyDocs = errors.New("empty docs")

var (
	rowPattern   = regexp.MustCompile(`<row\b[^>]*?(?:/>|>[\s\S]*?</row>)`)
	cellPattern  = regexp.MustCompile(`<c\b[^>]*?(?:/>|>[\s\S]*?</c>)`)
	mergePattern = regexp.MustCompile(`<mergeCells\b[^>]*?(?:/>|>[\s\S]*?</mergeCells>)`)
	brksPattern  = regexp.MustCompile(`<rowBreaks\b[^>]*?(?:/>|>[\s\S]*?</rowBreaks>)`)
	// A1 / $A$1 / 整行 1:5：可选列字母 + 行号；首组是边界字符（Go RE2 无 lookbehind，
	// 用捕获边界再原样回填替代 Elixir 的 (?<![A-Za-z0-9])）。
	refPattern = regexp.MustCompile(`(^|[^A-Za-z0-9])(\$?)([A-Za-z]{0,3})(\$?)(\d+)`)
)

type workbookSheetInfo struct {
	Name    string
	RelID   string
	SheetID string
	Tag     string
}

type zipEntry struct {
	Name string
	Data []byte
}

type xlsxPackage struct {
	Order     []string
	Parts     map[string][]byte
	Workbook  string
	Sheets    []workbookSheetInfo
	Rels      map[string]string
	SheetPath string
	Shared    []string
}

// RenderPages 打印用：单 sheet 顺序铺 N 份模板块，块间插入分页符（row break）。
func RenderPages(template []byte, docs []PrintDoc) ([]byte, error) {
	if len(docs) == 0 {
		return nil, ErrEmptyDocs
	}
	pkg, err := openPackage(template)
	if err != nil {
		return nil, err
	}
	blocks := make([]renderBlock, 0, len(docs))
	for _, doc := range docs {
		block, expandErr := expandSheet(pkg.Parts[pkg.SheetPath], pkg.Shared, doc)
		if expandErr != nil {
			return nil, expandErr
		}
		blocks = append(blocks, block)
	}
	rows, merges, breaks, dim, err := stitchBlocks(blocks)
	if err != nil {
		return nil, err
	}
	sheetOut, err := rebuildSheet(pkg.Parts[pkg.SheetPath], rows, merges, breaks, dim)
	if err != nil {
		return nil, err
	}
	wbOut := shiftPrintAreas(pkg.Workbook, blocks)
	pkg.Parts[pkg.SheetPath] = []byte(sheetOut)
	pkg.Parts["xl/workbook.xml"] = []byte(wbOut)
	return packPackage(pkg)
}

// RenderSheets 导出用：每份 doc 一个 sheet（sheet 名 31 字符截断、非法字符替换、去重）。
func RenderSheets(template []byte, docs []NamedDoc) ([]byte, error) {
	if len(docs) == 0 {
		return nil, ErrEmptyDocs
	}
	pkg, err := openPackage(template)
	if err != nil {
		return nil, err
	}
	templateSheet := pkg.Parts[pkg.SheetPath]
	names := uniqueSheetNames(docs)

	sheetEntries := make([]string, 0, len(docs))
	relsEntries := make([]string, 0, len(docs))
	overrides := make([]string, 0, len(docs))
	newParts := make(map[string][]byte, len(docs))
	for index, named := range docs {
		block, expandErr := expandSheet(templateSheet, pkg.Shared, named.Doc)
		if expandErr != nil {
			return nil, expandErr
		}
		dim := dimensionRef(block.maxCol, block.maxRow)
		sheetXML, rebuildErr := rebuildSheet(templateSheet, block.rows, block.merges, block.breaks, dim)
		if rebuildErr != nil {
			return nil, rebuildErr
		}
		i := index + 1
		partPath := fmt.Sprintf("xl/worksheets/sheet_synie_%d.xml", i)
		rid := fmt.Sprintf("rIdSynie%d", i)
		sheetEntries = append(sheetEntries,
			fmt.Sprintf(`<sheet name="%s" sheetId="%d" r:id="%s"/>`, xmlEscape(names[index]), 1000+i, rid))
		relsEntries = append(relsEntries,
			fmt.Sprintf(`<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet_synie_%d.xml"/>`, rid, i))
		overrides = append(overrides,
			fmt.Sprintf(`<Override PartName="/%s" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`, partPath))
		newParts[partPath] = []byte(sheetXML)
	}

	// workbook：sheets 段替换为仅导出 sheet（不要模板其它 sheet，避免空白页），剥掉打印区域
	wb := replaceSheetsSection(pkg.Workbook, strings.Join(sheetEntries, ""))
	wb = stripPrintAreas(wb)

	// rels：保留 styles / sharedStrings 等非 worksheet rel，去掉旧 worksheet rel，追加新的
	relsPath := "xl/_rels/workbook.xml.rels"
	oldRels := string(pkg.Parts[relsPath])
	kept := make([]string, 0)
	for _, tag := range relTagPattern.FindAllString(oldRels, -1) {
		if strings.Contains(tag, "/worksheet") || strings.Contains(tag, "worksheets/") {
			continue
		}
		kept = append(kept, tag)
	}
	inner := strings.Join(append(kept, relsEntries...), "")
	newRels := relationshipsPattern.ReplaceAllStringFunc(oldRels, func(full string) string {
		open := relationshipsOpenPattern.FindString(full)
		return open + inner + "</Relationships>"
	})

	// Content_Types：去掉旧 worksheet override，加新的
	ctPath := "[Content_Types].xml"
	ct := worksheetOverridePattern.ReplaceAllString(string(pkg.Parts[ctPath]), "")
	ct = strings.Replace(ct, "</Types>", strings.Join(overrides, "")+"</Types>", 1)

	for _, sheet := range pkg.Sheets {
		if resolved := resolveSheetPath(pkg.Rels[sheet.RelID]); resolved != "" {
			delete(pkg.Parts, resolved)
		}
	}
	pkg.Parts["xl/workbook.xml"] = []byte(wb)
	pkg.Parts[relsPath] = []byte(newRels)
	pkg.Parts[ctPath] = []byte(ct)
	for partPath, data := range newParts {
		pkg.Parts[partPath] = data
	}
	return packPackage(pkg)
}

var (
	relTagPattern            = regexp.MustCompile(`<Relationship\b[^>]*/>`)
	relationshipsPattern     = regexp.MustCompile(`<Relationships\b[^>]*>[\s\S]*</Relationships>`)
	relationshipsOpenPattern = regexp.MustCompile(`<Relationships\b[^>]*>`)
	worksheetOverridePattern = regexp.MustCompile(`<Override[^>]*worksheets/[^"']*"[^>]*/>`)
	sheetsSectionPattern     = regexp.MustCompile(`<sheets\b[^>]*>[\s\S]*?</sheets>`)
	printAreaPattern         = regexp.MustCompile(`<definedName([^>]*name="_xlnm\.Print_Area"[^>]*)>([\s\S]*?)</definedName>`)
	definedNamePattern       = regexp.MustCompile(`<definedName([^>]*)>([\s\S]*?)</definedName>`)
	definedNamesEmptyPattern = regexp.MustCompile(`<definedNames\s*/>|<definedNames>\s*</definedNames>`)
)

func replaceSheetsSection(wb, sheetsInner string) string {
	return sheetsSectionPattern.ReplaceAllString(wb, "<sheets>"+sheetsInner+"</sheets>")
}

func stripPrintAreas(wb string) string {
	wb = printAreaStrippPattern.ReplaceAllString(wb, "")
	return definedNamesEmptyPattern.ReplaceAllString(wb, "")
}

var printAreaStrippPattern = regexp.MustCompile(`<definedName[^>]*_xlnm\.Print_Area[^>]*>[\s\S]*?</definedName>`)

// openPackage 解包 xlsx 并定位第一个 sheet（与 ExtractPlaceholders 同一套解析约定）。
func openPackage(value []byte) (*xlsxPackage, error) {
	reader, err := zip.NewReader(bytes.NewReader(value), int64(len(value)))
	if err != nil {
		return nil, invalidTemplate("不是有效的 xlsx（zip）文件")
	}
	pkg := &xlsxPackage{Parts: make(map[string][]byte, len(reader.File))}
	for _, entry := range reader.File {
		stream, openErr := entry.Open()
		if openErr != nil {
			return nil, invalidTemplate("无法读取 " + entry.Name)
		}
		raw, readErr := io.ReadAll(stream)
		closeErr := stream.Close()
		if readErr != nil || closeErr != nil {
			return nil, invalidTemplate("无法读取 " + entry.Name)
		}
		name := path.Clean(strings.TrimLeft(entry.Name, "/"))
		pkg.Order = append(pkg.Order, name)
		pkg.Parts[name] = raw
	}
	workbook, ok := pkg.Parts["xl/workbook.xml"]
	if !ok {
		return nil, invalidTemplate("缺少 xl/workbook.xml")
	}
	relsRaw, ok := pkg.Parts["xl/_rels/workbook.xml.rels"]
	if !ok {
		return nil, invalidTemplate("缺少 xl/_rels/workbook.xml.rels")
	}
	pkg.Workbook = string(workbook)
	pkg.Rels = parseRelationships(relsRaw)
	pkg.Sheets = parseWorkbookSheets(pkg.Workbook)
	if len(pkg.Sheets) == 0 {
		return nil, invalidTemplate("workbook 中没有 sheet")
	}
	pkg.SheetPath = resolveSheetPath(pkg.Rels[pkg.Sheets[0].RelID])
	if pkg.SheetPath == "" {
		return nil, invalidTemplate("找不到第一个 sheet 对应的 part")
	}
	if _, ok := pkg.Parts[pkg.SheetPath]; !ok {
		return nil, invalidTemplate("找不到第一个 sheet 对应的 part")
	}
	shared, err := parseSharedStrings(pkg.Parts["xl/sharedStrings.xml"])
	if err != nil {
		return nil, err
	}
	pkg.Shared = shared
	return pkg, nil
}

var relAttrPattern = regexp.MustCompile(`Id="([^"]+)"[^>]*Target="([^"]+)"`)

func parseRelationships(value []byte) map[string]string {
	result := make(map[string]string)
	for _, match := range relAttrPattern.FindAllSubmatch(value, -1) {
		result[string(match[1])] = string(match[2])
	}
	return result
}

var wbSheetTagPattern = regexp.MustCompile(`<sheet\b[^>]*>`)

func parseWorkbookSheets(wb string) []workbookSheetInfo {
	result := make([]workbookSheetInfo, 0)
	for _, tag := range wbSheetTagPattern.FindAllString(wb, -1) {
		name := xmlAttr(tag, "name")
		rid := xmlAttr(tag, "r:id")
		if rid == "" {
			rid = xmlAttr(tag, "id")
		}
		if rid == "" || name == "" {
			continue
		}
		result = append(result, workbookSheetInfo{
			Name: name, RelID: rid, SheetID: xmlAttr(tag, "sheetId"), Tag: tag,
		})
	}
	return result
}

func resolveSheetPath(target string) string {
	target = strings.TrimLeft(target, "/")
	if target == "" {
		return ""
	}
	if strings.HasPrefix(target, "xl/") {
		return target
	}
	return "xl/" + target
}

// renderBlock 是一份单据展开后的模板块。
type renderBlock struct {
	rows   []string
	merges []string
	breaks []int
	maxRow int
	maxCol int
}

type loopContext struct {
	prefix string
	fields map[string]string
}

// loopPlanEntry 记录一个循环区的模板行号与展开行数（merge/分页符顺移用）。
type loopPlanEntry struct {
	templateRow int
	count       int
}

// expandSheet 展开单份模板块：逐行标注循环区模板行；多循环区各占一段，顺序展开，delta 累计下移。
func expandSheet(sheetXML []byte, shared []string, doc PrintDoc) (renderBlock, error) {
	fields := doc.Fields
	if fields == nil {
		fields = map[string]string{}
	}
	loops := doc.Loops
	if loops == nil {
		loops = map[string][]map[string]string{}
	}
	loopNames := make(map[string]struct{}, len(loops))
	for name := range loops {
		loopNames[name] = struct{}{}
	}

	sheet := string(sheetXML)
	rows := rowPattern.FindAllString(sheet, -1)
	if len(rows) == 0 {
		return renderBlock{}, invalidTemplate("sheet 中没有 row")
	}

	outRows := make([]string, 0, len(rows))
	delta := 0
	plan := make([]loopPlanEntry, 0)

	for _, row := range rows {
		prefix := loopRowPrefix(row, shared, loopNames)
		if prefix == "" {
			shifted, shiftErr := shiftRowXML(row, delta)
			if shiftErr != nil {
				return renderBlock{}, shiftErr
			}
			outRows = append(outRows, fillRow(shifted, shared, fields, loopNames, nil))
			continue
		}
		items := loops[prefix]
		templateRow, err := rowNumber(row)
		if err != nil {
			return renderBlock{}, err
		}
		for seq, item := range items {
			itemFields := make(map[string]string, len(item)+1)
			for key, value := range item {
				itemFields[key] = value
			}
			itemFields["_seq"] = strconv.Itoa(seq + 1)
			shifted, shiftErr := shiftRowXML(row, delta+seq)
			if shiftErr != nil {
				return renderBlock{}, shiftErr
			}
			outRows = append(outRows,
				fillRow(shifted, shared, fields, loopNames, &loopContext{prefix: prefix, fields: itemFields}))
		}
		delta += len(items) - 1
		plan = append(plan, loopPlanEntry{templateRow: templateRow, count: len(items)})
	}

	deltaBefore := func(row int) int {
		total := 0
		for _, entry := range plan {
			if entry.templateRow < row {
				total += entry.count - 1
			}
		}
		return total
	}

	merges := make([]string, 0)
	for _, ref := range extractMergeRefs(sheet) {
		if shifted, ok := shiftMergeForLoops(ref, plan, deltaBefore); ok {
			merges = append(merges, shifted)
		}
	}

	// 模板自带手工分页符随循环区展开顺移：传 b+1 使循环模板行自身带分页符
	// 也按整段展开后计入（等价 t_r <= b）
	breaks := make([]int, 0)
	for _, b := range extractRowBreaks(sheet) {
		breaks = append(breaks, b+deltaBefore(b+1))
	}

	maxRow := 1
	for _, row := range outRows {
		number, err := rowNumber(row)
		if err != nil {
			return renderBlock{}, err
		}
		if number > maxRow {
			maxRow = number
		}
	}
	return renderBlock{
		rows: outRows, merges: merges, breaks: breaks,
		maxRow: maxRow, maxCol: maxColumn(outRows),
	}, nil
}

// loopRowPrefix 返回行内第一个循环区占位符的首段（该行为该循环区的模板行）；无则空串。
func loopRowPrefix(row string, shared []string, loopNames map[string]struct{}) string {
	for _, cell := range cellPattern.FindAllString(row, -1) {
		text, ok := cellText(cell, shared)
		if !ok {
			continue
		}
		for _, match := range placeholderPattern.FindAllStringSubmatch(text, -1) {
			name := match[1]
			if index := strings.IndexByte(name, '.'); index >= 0 {
				if _, isLoop := loopNames[name[:index]]; isLoop {
					return name[:index]
				}
			}
		}
	}
	return ""
}

func fillRow(row string, shared []string, fields map[string]string,
	loopNames map[string]struct{}, loop *loopContext) string {
	return cellPattern.ReplaceAllStringFunc(row, func(cell string) string {
		return fillCell(cell, shared, fields, loopNames, loop)
	})
}

func fillCell(cell string, shared []string, fields map[string]string,
	loopNames map[string]struct{}, loop *loopContext) string {
	text, ok := cellText(cell, shared)
	if !ok || !placeholderPattern.MatchString(text) {
		return cell
	}
	replaced := replaceSubmatch(placeholderPattern, text, func(match []string) string {
		name := match[1]
		index := strings.IndexByte(name, '.')
		if index < 0 {
			return fields[name]
		}
		prefix, rest := name[:index], name[index+1:]
		switch {
		case loop != nil && loop.prefix == prefix:
			// 本循环区模板行内的该区占位
			return loop.fields[rest]
		default:
			if _, isLoop := loopNames[prefix]; isLoop {
				// 循环占位出现在其模板行之外 → 空
				return ""
			}
			// 头字段路径（关系.字段）
			return fields[name]
		}
	})
	return replaceCellWithInline(cell, replaced)
}

// replaceCellWithInline 保留 r= 与 s= 样式，改写为 inline string。
func replaceCellWithInline(cell, text string) string {
	r := xmlAttr(cell, "r")
	if r == "" {
		r = "A1"
	}
	sAttr := ""
	if s := xmlAttr(cell, "s"); s != "" {
		sAttr = fmt.Sprintf(` s="%s"`, s)
	}
	return fmt.Sprintf(`<c r="%s"%s t="inlineStr"><is><t>%s</t></is></c>`, r, sAttr, xmlEscape(text))
}

var (
	inlineTextPattern  = regexp.MustCompile(`<t[^>]*>([^<]*)</t>`)
	sharedIndexPattern = regexp.MustCompile(`<v>([^<]*)</v>`)
	isTextPattern      = regexp.MustCompile(`<is><t[^>]*>([^<]*)</t></is>`)
)

// cellText 取单元格文本；普通数字/公式格返回 ok=false（占位符不会出现）。
func cellText(cell string, shared []string) (string, bool) {
	switch {
	case strings.Contains(cell, `t="inlineStr"`) || strings.Contains(cell, `t='inlineStr'`):
		if match := inlineTextPattern.FindStringSubmatch(cell); match != nil {
			return xmlUnescape(match[1]), true
		}
		return "", true
	case strings.Contains(cell, `t="s"`) || strings.Contains(cell, `t='s'`):
		match := sharedIndexPattern.FindStringSubmatch(cell)
		if match == nil {
			return "", false
		}
		index, err := strconv.Atoi(match[1])
		if err != nil || index < 0 || index >= len(shared) {
			return "", false
		}
		return shared[index], true
	default:
		if match := isTextPattern.FindStringSubmatch(cell); match != nil {
			return xmlUnescape(match[1]), true
		}
		return "", false
	}
}

// stitchBlocks 拼接多块：行/merge/分页符按块最大行号偏移，块间边界加分页符。
func stitchBlocks(blocks []renderBlock) (rows []string, merges []string, breaks []int, dim string, err error) {
	if len(blocks) == 1 {
		only := blocks[0]
		return only.rows, only.merges, only.breaks, dimensionRef(only.maxCol, only.maxRow), nil
	}
	offset := 0
	maxCol := 1
	for _, block := range blocks {
		for _, row := range block.rows {
			shifted, shiftErr := shiftRowXML(row, offset)
			if shiftErr != nil {
				return nil, nil, nil, "", shiftErr
			}
			rows = append(rows, shifted)
		}
		for _, ref := range block.merges {
			merges = append(merges, shiftRef(ref, offset))
		}
		for _, b := range block.breaks {
			breaks = append(breaks, b+offset)
		}
		offset += block.maxRow
		// 分页符在块末行（Excel brk id = 该行之后分页，用块最大行号）
		breaks = append(breaks, offset)
		if block.maxCol > maxCol {
			maxCol = block.maxCol
		}
	}
	// 最后一块后不需要块间分页符；块自带分页符与边界重合时去重
	if len(breaks) > 0 {
		breaks = breaks[:len(breaks)-1]
	}
	breaks = uniqueSortedInts(breaks)
	return rows, merges, breaks, dimensionRef(maxCol, offset), nil
}

// shiftPrintAreas 批量打印时打印区域按块复制并偏移（workbook definedNames）。
func shiftPrintAreas(wb string, blocks []renderBlock) string {
	if len(blocks) <= 1 {
		return wb
	}
	offsets := make([]int, 0, len(blocks))
	offset := 0
	for _, block := range blocks {
		offsets = append(offsets, offset)
		offset += block.maxRow
	}
	return replaceSubmatch(printAreaPattern, wb, func(full []string) string {
		whole := full[0]
		if !strings.Contains(whole, `localSheetId="0"`) &&
			!strings.Contains(whole, `localSheetId='0'`) &&
			strings.Contains(whole, "localSheetId") {
			return whole
		}
		match := definedNamePattern.FindStringSubmatch(whole)
		if match == nil {
			return whole
		}
		attrs, body := match[1], strings.TrimSpace(match[2])
		// body 形如 'Sheet1'!$A$1:$D$10
		areaParts := sheetAreaPattern.FindStringSubmatch(body)
		if areaParts == nil {
			return whole
		}
		prefix, area := areaParts[1], areaParts[2]
		areas := make([]string, 0, len(offsets))
		for _, off := range offsets {
			areas = append(areas, prefix+shiftRef(area, off))
		}
		return "<definedName" + attrs + ">" + strings.Join(areas, ",") + "</definedName>"
	})
}

var sheetAreaPattern = regexp.MustCompile(`^(.*!)(.*)$`)

// rebuildSheet 用展开结果重建 sheet XML：sheetData / dimension / mergeCells / rowBreaks。
func rebuildSheet(template []byte, rows []string, merges []string, breaks []int, dim string) (string, error) {
	sheet := string(template)
	sheetData := "<sheetData>" + strings.Join(rows, "") + "</sheetData>"
	if !sheetDataOpenPattern.MatchString(sheet) {
		return "", invalidTemplate("sheet 缺少 sheetData")
	}
	sheet = sheetDataPattern.ReplaceAllString(sheet, sheetData)

	if dimensionAnyPattern.MatchString(sheet) {
		sheet = dimensionPattern.ReplaceAllString(sheet, fmt.Sprintf(`<dimension ref="%s"/>`, dim))
	} else {
		sheet = strings.Replace(sheet, "<sheetData",
			fmt.Sprintf(`<dimension ref="%s"/><sheetData`, dim), 1)
	}

	mergeXML := ""
	if len(merges) > 0 {
		inner := make([]string, 0, len(merges))
		for _, ref := range merges {
			inner = append(inner, fmt.Sprintf(`<mergeCell ref="%s"/>`, ref))
		}
		mergeXML = fmt.Sprintf(`<mergeCells count="%d">%s</mergeCells>`, len(merges), strings.Join(inner, ""))
	}
	sheet = mergePattern.ReplaceAllString(sheet, "")
	if mergeXML != "" {
		sheet = strings.Replace(sheet, "</sheetData>", "</sheetData>"+mergeXML, 1)
	}

	brksXML := ""
	if len(breaks) > 0 {
		inner := make([]string, 0, len(breaks))
		for _, id := range breaks {
			inner = append(inner, fmt.Sprintf(`<brk id="%d" max="16383" man="1"/>`, id))
		}
		brksXML = fmt.Sprintf(`<rowBreaks count="%d" manualBreakCount="%d">%s</rowBreaks>`,
			len(breaks), len(breaks), strings.Join(inner, ""))
	}
	sheet = brksPattern.ReplaceAllString(sheet, "")
	if brksXML != "" {
		// CT_Worksheet 中 rowBreaks 在 pageSetup 一带；插在 </worksheet> 前对 LO/Excel 均合法
		if strings.Contains(sheet, "</worksheet>") {
			sheet = strings.Replace(sheet, "</worksheet>", brksXML+"</worksheet>", 1)
		} else {
			sheet += brksXML
		}
	}
	return sheet, nil
}

var (
	sheetDataOpenPattern = regexp.MustCompile(`<sheetData\b`)
	sheetDataPattern     = regexp.MustCompile(`<sheetData\b[^>]*>[\s\S]*?</sheetData>`)
	dimensionPattern     = regexp.MustCompile(`<dimension\b[^>]*/>`)
	dimensionAnyPattern  = regexp.MustCompile(`<dimension\b`)
)

// shiftMergeForLoops 多循环区 merge 顺移：整段落在某循环模板行上的 merge 丢弃
// （约定不跨循环行）；其余按各端点行号下方的累计 delta 分别顺移。
func shiftMergeForLoops(ref string, plan []loopPlanEntry, deltaBefore func(int) int) (string, bool) {
	r1, r2 := refRowRange(ref)
	for _, entry := range plan {
		if entry.templateRow == r1 && r1 == r2 {
			return "", false
		}
	}
	return shiftRefRows(ref, deltaBefore), true
}

// refRowRange 取 ref 中全部数字的最小/最大行号。
func refRowRange(ref string) (int, int) {
	matches := digitsPattern.FindAllString(ref, -1)
	if len(matches) == 0 {
		return 0, 0
	}
	min, max := 0, 0
	for index, text := range matches {
		value, err := strconv.Atoi(text)
		if err != nil {
			continue
		}
		if index == 0 || value < min {
			min = value
		}
		if index == 0 || value > max {
			max = value
		}
	}
	return min, max
}

var digitsPattern = regexp.MustCompile(`(\d+)`)

// shiftRefRows 两端点按各自下方的累计 delta 分别顺移。
func shiftRefRows(ref string, deltaOf func(int) int) string {
	return replaceSubmatch(refPattern, ref, func(match []string) string {
		row, err := strconv.Atoi(match[5])
		if err != nil {
			return match[0]
		}
		return match[1] + match[2] + match[3] + match[4] + strconv.Itoa(row+deltaOf(row))
	})
}

// shiftRef 整体偏移 ref 中的行号。
func shiftRef(ref string, delta int) string {
	if delta == 0 {
		return ref
	}
	return shiftRefRows(ref, func(int) int { return delta })
}

// shiftRowXML 行内单元格 ref 与 row 的 r 属性整体下移 delta。
func shiftRowXML(row string, delta int) (string, error) {
	if delta == 0 {
		return row, nil
	}
	r0, err := rowNumber(row)
	if err != nil {
		return "", err
	}
	r1 := r0 + delta
	shifted := cellPattern.ReplaceAllStringFunc(row, func(cell string) string {
		ref := xmlAttr(cell, "r")
		if ref == "" {
			return cell
		}
		return strings.Replace(cell, `r="`+ref+`"`, `r="`+shiftA1(ref, delta)+`"`, 1)
	})
	rowAttrPattern := regexp.MustCompile(`<row\b([^>]*)\br="` + strconv.Itoa(r0) + `"`)
	return rowAttrPattern.ReplaceAllString(shifted, `<row$1 r="`+strconv.Itoa(r1)+`"`), nil
}

var a1Pattern = regexp.MustCompile(`^(\$?)([A-Za-z]+)(\$?)(\d+)$`)

func shiftA1(ref string, delta int) string {
	match := a1Pattern.FindStringSubmatch(ref)
	if match == nil {
		return ref
	}
	row, err := strconv.Atoi(match[4])
	if err != nil {
		return ref
	}
	return match[1] + match[2] + match[3] + strconv.Itoa(row+delta)
}

func rowNumber(row string) (int, error) {
	value := xmlAttr(row, "r")
	if value == "" {
		return 0, invalidTemplate("row 缺少 r 属性")
	}
	number, err := strconv.Atoi(value)
	if err != nil {
		return 0, invalidTemplate("row 缺少 r 属性")
	}
	return number, nil
}

var mergeRefPattern = regexp.MustCompile(`ref="([^"]+)"`)

func extractMergeRefs(sheet string) []string {
	block := mergePattern.FindString(sheet)
	if block == "" {
		return nil
	}
	result := make([]string, 0)
	for _, match := range mergeRefPattern.FindAllStringSubmatch(block, -1) {
		result = append(result, match[1])
	}
	return result
}

var brkIDPattern = regexp.MustCompile(`<brk\b[^>]*\bid="(\d+)"`)

func extractRowBreaks(sheet string) []int {
	block := brksPattern.FindString(sheet)
	if block == "" {
		return nil
	}
	result := make([]int, 0)
	for _, match := range brkIDPattern.FindAllStringSubmatch(block, -1) {
		if id, err := strconv.Atoi(match[1]); err == nil {
			result = append(result, id)
		}
	}
	return result
}

var colLettersPattern = regexp.MustCompile(`^\$?([A-Za-z]+)`)

func maxColumn(rows []string) int {
	max := 1
	for _, row := range rows {
		for _, cell := range cellPattern.FindAllString(row, -1) {
			index := colIndex(xmlAttr(cell, "r"))
			if index > max {
				max = index
			}
		}
	}
	return max
}

func colIndex(ref string) int {
	match := colLettersPattern.FindStringSubmatch(ref)
	if match == nil {
		return 1
	}
	index := 0
	for _, c := range strings.ToUpper(match[1]) {
		index = index*26 + int(c-'A'+1)
	}
	if index < 1 {
		return 1
	}
	return index
}

func dimensionRef(maxCol, maxRow int) string {
	if maxRow < 1 {
		maxRow = 1
	}
	return "A1:" + colLetters(maxCol-1) + strconv.Itoa(maxRow)
}

// colLetters 0 基列号转列字母（0→A）。
func colLetters(n int) string {
	if n < 0 {
		n = 0
	}
	result := make([]byte, 0, 3)
	for {
		result = append([]byte{byte('A' + n%26)}, result...)
		n = n/26 - 1
		if n < 0 {
			return string(result)
		}
	}
}

// uniqueSheetNames sheet 名非法字符替换、31 字符截断、去重（" N" 后缀）。
func uniqueSheetNames(docs []NamedDoc) []string {
	seen := make(map[string]struct{}, len(docs))
	result := make([]string, 0, len(docs))
	for _, doc := range docs {
		base := sanitizeSheetName(doc.Name)
		candidate := base
		for n := 1; ; n++ {
			if _, taken := seen[candidate]; !taken {
				break
			}
			suffix := " " + strconv.Itoa(n)
			runes := []rune(base)
			limit := 31 - len([]rune(suffix))
			if limit < 1 {
				limit = 1
			}
			if len(runes) > limit {
				runes = runes[:limit]
			}
			candidate = string(runes) + suffix
		}
		seen[candidate] = struct{}{}
		result = append(result, candidate)
	}
	return result
}

var sheetNameIllegalPattern = regexp.MustCompile(`[:\\/\?\*\[\]]`)

func sanitizeSheetName(name string) string {
	name = strings.TrimSpace(sheetNameIllegalPattern.ReplaceAllString(name, " "))
	if name == "" {
		name = "Sheet"
	}
	runes := []rune(name)
	if len(runes) > 31 {
		runes = runes[:31]
	}
	return string(runes)
}

// packPackage 按原 part 顺序重打包（map 中已删除的 part 丢弃，新增 part 按名序追加）。
func packPackage(pkg *xlsxPackage) ([]byte, error) {
	entries := make([]zipEntry, 0, len(pkg.Parts))
	known := make(map[string]struct{}, len(pkg.Order))
	for _, name := range pkg.Order {
		known[name] = struct{}{}
		if data, ok := pkg.Parts[name]; ok {
			entries = append(entries, zipEntry{Name: name, Data: data})
		}
	}
	extra := make([]string, 0)
	for name := range pkg.Parts {
		if _, ok := known[name]; !ok {
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	for _, name := range extra {
		entries = append(entries, zipEntry{Name: name, Data: pkg.Parts[name]})
	}
	return packZipEntries(entries)
}

func packZipEntries(entries []zipEntry) ([]byte, error) {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.Name, Method: zip.Deflate}
		part, err := writer.CreateHeader(header)
		if err != nil {
			return nil, fmt.Errorf("重打包 xlsx 失败: %w", err)
		}
		if _, err := part.Write(entry.Data); err != nil {
			return nil, fmt.Errorf("重打包 xlsx 失败: %w", err)
		}
	}
	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("重打包 xlsx 失败: %w", err)
	}
	return buffer.Bytes(), nil
}

// xmlAttr 取标签属性（双引号优先，兼容单引号）。
func xmlAttr(tag, name string) string {
	if match := regexp.MustCompile(regexp.QuoteMeta(name) + `="([^"]*)"`).FindStringSubmatch(tag); match != nil {
		return match[1]
	}
	if match := regexp.MustCompile(regexp.QuoteMeta(name) + `='([^']*)'`).FindStringSubmatch(tag); match != nil {
		return match[1]
	}
	return ""
}

func xmlEscape(value string) string {
	value = strings.ReplaceAll(value, "&", "&amp;")
	value = strings.ReplaceAll(value, "<", "&lt;")
	value = strings.ReplaceAll(value, ">", "&gt;")
	return strings.ReplaceAll(value, `"`, "&quot;")
}

func xmlUnescape(value string) string {
	value = strings.ReplaceAll(value, "&lt;", "<")
	value = strings.ReplaceAll(value, "&gt;", ">")
	value = strings.ReplaceAll(value, "&quot;", `"`)
	return strings.ReplaceAll(value, "&amp;", "&")
}

// replaceSubmatch 以子匹配回调替换全部命中。
func replaceSubmatch(pattern *regexp.Regexp, value string, fn func([]string) string) string {
	return pattern.ReplaceAllStringFunc(value, func(match string) string {
		return fn(pattern.FindStringSubmatch(match))
	})
}

func uniqueSortedInts(values []int) []int {
	set := make(map[int]struct{}, len(values))
	for _, value := range values {
		set[value] = struct{}{}
	}
	result := make([]int, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Ints(result)
	return result
}
