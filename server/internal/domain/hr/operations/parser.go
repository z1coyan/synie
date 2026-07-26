package operations

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

const maxImportRows = 100_000

type parsedPunch struct {
	AttendanceNo string
	PunchedAt    time.Time
}

type parsedFile struct {
	Rows               []parsedPunch
	TotalRows, BadRows int64
	DupRows            int64
}

func parseAttendanceFile(value []byte) (parsedFile, error) {
	raw := strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(string(value))
	lines := strings.Split(raw, "\n")
	nonblank := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			nonblank = append(nonblank, line)
		}
	}
	total := len(nonblank)
	if total == 0 {
		return parsedFile{}, fmt.Errorf("文件为空,未解析到打卡行")
	}
	if total > maxImportRows {
		return parsedFile{}, fmt.Errorf("文件超过 %d 行上限,请拆分后导入", maxImportRows)
	}
	result := parsedFile{Rows: make([]parsedPunch, 0, total), TotalRows: int64(total)}
	seen := make(map[string]struct{}, total)
	for _, line := range nonblank {
		fields := strings.Fields(line)
		if len(fields) < 3 || len(fields[0]) < 1 || len(fields[0]) > 64 {
			result.BadRows++
			continue
		}
		local, err := time.ParseInLocation("2006-01-02 15:04:05", fields[1]+" "+fields[2], time.UTC)
		if err != nil {
			result.BadRows++
			continue
		}
		punchedAt := local.Add(-attendanceImportUTCOffset).UTC()
		key := fields[0] + "\x00" + punchedAt.Format(time.RFC3339Nano)
		if _, exists := seen[key]; exists {
			result.DupRows++
			continue
		}
		seen[key] = struct{}{}
		result.Rows = append(result.Rows, parsedPunch{AttendanceNo: fields[0], PunchedAt: punchedAt})
	}
	if len(result.Rows) == 0 {
		return parsedFile{}, fmt.Errorf("未解析到有效打卡行(共 %d 行均无法识别)", total)
	}
	return result, nil
}

func unmatchedDetail(rows []parsedPunch, matched map[string]uuid.UUID) *string {
	counts := make(map[string]int)
	for _, row := range rows {
		if _, ok := matched[row.AttendanceNo]; !ok {
			counts[row.AttendanceNo]++
		}
	}
	if len(counts) == 0 {
		return nil
	}
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	total := len(keys)
	if len(keys) > 50 {
		keys = keys[:50]
	}
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s×%d", key, counts[key]))
	}
	value := strings.Join(parts, "、")
	if total > 50 {
		value += fmt.Sprintf("……(等共 %d 个编号)", total)
	}
	if len(value) > 2000 {
		value = value[:2000]
	}
	return &value
}
