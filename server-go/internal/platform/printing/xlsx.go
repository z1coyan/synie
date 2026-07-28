package printing

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var placeholderPattern = regexp.MustCompile(`\$\{([^{}]+)\}`)

type workbookSheet struct {
	RelationID string
}

type workbookRelationship struct {
	ID     string `xml:"Id,attr"`
	Target string `xml:"Target,attr"`
}

type workbookRelationships struct {
	Relationships []workbookRelationship `xml:"Relationship"`
}

type worksheetCell struct {
	Type  string
	Value string
	Texts []string
}

func ExtractPlaceholders(value []byte) (PlaceholderSet, error) {
	reader, err := zip.NewReader(bytes.NewReader(value), int64(len(value)))
	if err != nil {
		return PlaceholderSet{}, invalidTemplate("不是有效的 xlsx（zip）文件")
	}
	parts := make(map[string][]byte, len(reader.File))
	for _, entry := range reader.File {
		stream, openErr := entry.Open()
		if openErr != nil {
			return PlaceholderSet{}, invalidTemplate("无法读取 " + entry.Name)
		}
		raw, readErr := io.ReadAll(stream)
		closeErr := stream.Close()
		if readErr != nil || closeErr != nil {
			return PlaceholderSet{}, invalidTemplate("无法读取 " + entry.Name)
		}
		parts[path.Clean(strings.TrimLeft(entry.Name, "/"))] = raw
	}
	workbook, ok := parts["xl/workbook.xml"]
	if !ok {
		return PlaceholderSet{}, invalidTemplate("缺少 xl/workbook.xml")
	}
	relationshipsRaw, ok := parts["xl/_rels/workbook.xml.rels"]
	if !ok {
		return PlaceholderSet{}, invalidTemplate("缺少 xl/_rels/workbook.xml.rels")
	}
	relationID, err := firstSheetRelation(workbook)
	if err != nil {
		return PlaceholderSet{}, err
	}
	var relationships workbookRelationships
	if err := xml.Unmarshal(relationshipsRaw, &relationships); err != nil {
		return PlaceholderSet{}, invalidTemplate("无法解析工作簿关系")
	}
	target := ""
	for _, relationship := range relationships.Relationships {
		if relationship.ID == relationID {
			target = relationship.Target
			break
		}
	}
	if target == "" {
		return PlaceholderSet{}, invalidTemplate("找不到首个工作表")
	}
	sheetPath := path.Clean(path.Join("xl", strings.TrimLeft(target, "/")))
	sheet, ok := parts[sheetPath]
	if !ok {
		return PlaceholderSet{}, invalidTemplate("缺少首个工作表")
	}
	shared, err := parseSharedStrings(parts["xl/sharedStrings.xml"])
	if err != nil {
		return PlaceholderSet{}, err
	}
	texts, err := parseWorksheetTexts(sheet, shared)
	if err != nil {
		return PlaceholderSet{}, err
	}
	return placeholdersFromTexts(texts), nil
}

func firstSheetRelation(value []byte) (string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(value))
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return "", invalidTemplate("工作簿没有工作表")
		}
		if err != nil {
			return "", invalidTemplate("无法解析 xl/workbook.xml")
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "sheet" {
			continue
		}
		for _, attribute := range start.Attr {
			if attribute.Name.Local == "id" {
				return attribute.Value, nil
			}
		}
		return "", invalidTemplate("首个工作表缺少关系")
	}
}

func parseSharedStrings(value []byte) ([]string, error) {
	if len(value) == 0 {
		return nil, nil
	}
	decoder := xml.NewDecoder(bytes.NewReader(value))
	result := make([]string, 0)
	var current strings.Builder
	inItem := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return result, nil
		}
		if err != nil {
			return nil, invalidTemplate("无法解析共享字符串")
		}
		switch typed := token.(type) {
		case xml.StartElement:
			if typed.Name.Local == "si" {
				current.Reset()
				inItem = true
			}
			if typed.Name.Local == "t" && inItem {
				var text string
				if err := decoder.DecodeElement(&text, &typed); err != nil {
					return nil, invalidTemplate("无法解析共享字符串")
				}
				current.WriteString(text)
			}
		case xml.EndElement:
			if typed.Name.Local == "si" && inItem {
				result = append(result, current.String())
				inItem = false
			}
		}
	}
}

func parseWorksheetTexts(value []byte, shared []string) ([]string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(value))
	result := make([]string, 0)
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return result, nil
		}
		if err != nil {
			return nil, invalidTemplate("无法解析首个工作表")
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "c" {
			continue
		}
		cell, err := decodeWorksheetCell(decoder, start)
		if err != nil {
			return nil, err
		}
		if cell.Type == "s" {
			index, parseErr := strconv.Atoi(strings.TrimSpace(cell.Value))
			if parseErr == nil && index >= 0 && index < len(shared) {
				result = append(result, shared[index])
			}
			continue
		}
		if len(cell.Texts) > 0 {
			result = append(result, strings.Join(cell.Texts, ""))
		} else if cell.Value != "" {
			result = append(result, cell.Value)
		}
	}
}

func decodeWorksheetCell(decoder *xml.Decoder, start xml.StartElement) (worksheetCell, error) {
	cell := worksheetCell{}
	for _, attribute := range start.Attr {
		if attribute.Name.Local == "t" {
			cell.Type = attribute.Value
		}
	}
	for {
		token, err := decoder.Token()
		if err != nil {
			return worksheetCell{}, invalidTemplate("无法解析首个工作表")
		}
		switch typed := token.(type) {
		case xml.StartElement:
			switch typed.Name.Local {
			case "v":
				if err := decoder.DecodeElement(&cell.Value, &typed); err != nil {
					return worksheetCell{}, invalidTemplate("无法解析首个工作表")
				}
			case "t":
				var text string
				if err := decoder.DecodeElement(&text, &typed); err != nil {
					return worksheetCell{}, invalidTemplate("无法解析首个工作表")
				}
				cell.Texts = append(cell.Texts, text)
			}
		case xml.EndElement:
			if typed.Name.Local == start.Name.Local {
				return cell, nil
			}
		}
	}
}

func placeholdersFromTexts(texts []string) PlaceholderSet {
	fields := make([]string, 0)
	nested := make(map[string][]string)
	for _, text := range texts {
		for _, match := range placeholderPattern.FindAllStringSubmatch(text, -1) {
			name := strings.TrimSpace(match[1])
			if name == "" {
				continue
			}
			index := strings.IndexByte(name, '.')
			if index < 0 {
				fields = append(fields, name)
				continue
			}
			prefix, suffix := name[:index], name[index+1:]
			nested[prefix] = append(nested[prefix], suffix)
		}
	}
	fields = uniqueSorted(fields)
	for prefix, values := range nested {
		nested[prefix] = uniqueSorted(values)
	}
	return PlaceholderSet{Fields: fields, Nested: nested}
}

func invalidTemplate(message string) error {
	return fmt.Errorf("无法解析模板: %s", message)
}

func sortedKeys[V any](values map[string]V) []string {
	result := make([]string, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	sort.Strings(result)
	return result
}
