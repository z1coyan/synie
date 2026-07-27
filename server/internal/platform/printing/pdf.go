package printing

// PDF 转换 seam：LibreOffice headless 哑转换，xlsx 二进制 → PDF 二进制。
// 移植自 Elixir SynieCore.Printing.PdfConverter（plans/006 进程卫生约束）：
//   - 每次转换使用独立 UserInstallation profile，避免 soffice 单实例锁
//   - 转换命令经系统 timeout(1) 包裹（默认 TERM 信号 + `-k 5` 秒 KILL 升级），
//     超时对进程组发信号，能覆盖 soffice 派生的子进程，避免外部进程沦为孤儿；
//     找不到 timeout(1) 时直接跑 soffice，此时超时仅由 Go 侧 context 兜底，
//     不保证杀死 soffice 进程组
//   - 全局并发上限（默认 2，SOFFICE_MAX_CONCURRENCY），过载排队而不是压垮容器
//   - 不做占位符填充、不改 page setup、不合并 PDF；导出 xlsx 路径不得调用本模块
//
// 配置：SOFFICE_PATH（默认 "soffice"）、SOFFICE_TIMEOUT_MS（默认 120000）。

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// 转换错误契约（服务层按类型映射中文文案，勿改语义）：
var (
	// ErrSofficeNotFound 未找到 LibreOffice 可执行文件
	ErrSofficeNotFound = errors.New("soffice_not_found")
	// ErrSofficeTimeout 转换超时（进程已被 timeout(1) 或 context 终止）
	ErrSofficeTimeout = errors.New("timeout")
	// ErrSofficeNoOutput 转换未产出 PDF 文件
	ErrSofficeNoOutput = errors.New("no_output")
)

// ConvertFailedError soffice 非零退出。
type ConvertFailedError struct {
	Detail string
}

func (e *ConvertFailedError) Error() string {
	if e.Detail == "" {
		return "convert_failed"
	}
	return "convert_failed: " + e.Detail
}

// PDFConverter 可注入的转换接口（无 soffice 的环境可降级或替换）。
type PDFConverter interface {
	ConvertXlsxToPDF(ctx context.Context, xlsx []byte) ([]byte, error)
}

const (
	defaultSofficeTimeout       = 120 * time.Second
	defaultSofficeMaxConcurrent = 2
)

// SofficeConverter 经 LibreOffice headless 转换。
type SofficeConverter struct {
	Path    string
	Timeout time.Duration
	sem     chan struct{}
}

// NewSofficeConverter 构造转换器；maxConcurrency < 1 时取默认值 2。
func NewSofficeConverter(path string, timeout time.Duration, maxConcurrency int) *SofficeConverter {
	if path == "" {
		path = "soffice"
	}
	if timeout <= 0 {
		timeout = defaultSofficeTimeout
	}
	if maxConcurrency < 1 {
		maxConcurrency = defaultSofficeMaxConcurrent
	}
	return &SofficeConverter{Path: path, Timeout: timeout, sem: make(chan struct{}, maxConcurrency)}
}

// NewSofficeConverterFromEnv 按 SOFFICE_PATH / SOFFICE_TIMEOUT_MS / SOFFICE_MAX_CONCURRENCY 构造。
func NewSofficeConverterFromEnv() *SofficeConverter {
	path := os.Getenv("SOFFICE_PATH")
	timeout := defaultSofficeTimeout
	if raw := os.Getenv("SOFFICE_TIMEOUT_MS"); raw != "" {
		if ms, err := strconv.Atoi(raw); err == nil && ms > 0 {
			timeout = time.Duration(ms) * time.Millisecond
		}
	}
	maxConcurrency := defaultSofficeMaxConcurrent
	if raw := os.Getenv("SOFFICE_MAX_CONCURRENCY"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			maxConcurrency = n
		}
	}
	return NewSofficeConverter(path, timeout, maxConcurrency)
}

// ConvertXlsxToPDF 将 xlsx 二进制转为 PDF 二进制。
func (c *SofficeConverter) ConvertXlsxToPDF(ctx context.Context, xlsx []byte) ([]byte, error) {
	if !c.available() {
		return nil, ErrSofficeNotFound
	}
	// 全局并发限流：转换前取令牌，转换后（无论成败）归还
	select {
	case c.sem <- struct{}{}:
		defer func() { <-c.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return c.doConvert(ctx, xlsx)
}

func (c *SofficeConverter) available() bool {
	if c.Path == "" {
		return false
	}
	if strings.ContainsRune(c.Path, '/') || strings.ContainsRune(c.Path, '\\') {
		info, err := os.Stat(c.Path)
		return err == nil && info.Mode().IsRegular()
	}
	_, err := exec.LookPath(c.Path)
	return err == nil
}

func (c *SofficeConverter) doConvert(ctx context.Context, xlsx []byte) ([]byte, error) {
	tmpRoot, err := os.MkdirTemp("", "synie-print-")
	if err != nil {
		return nil, fmt.Errorf("创建转换临时目录失败: %w", err)
	}
	defer os.RemoveAll(tmpRoot)

	inDir := filepath.Join(tmpRoot, "in")
	outDir := filepath.Join(tmpRoot, "out")
	profileDir := filepath.Join(tmpRoot, "profile")
	for _, dir := range []string{inDir, outDir, profileDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("创建转换临时目录失败: %w", err)
		}
	}
	inPath := filepath.Join(inDir, "doc.xlsx")
	if err := os.WriteFile(inPath, xlsx, 0o600); err != nil {
		return nil, fmt.Errorf("写入转换输入失败: %w", err)
	}

	args := []string{
		"--headless",
		"--norestore",
		"--nolockcheck",
		"-env:UserInstallation=file://" + profileDir,
		"--convert-to", "pdf",
		"--outdir", outDir,
		inPath,
	}

	// 找得到 timeout(1) 就用它包裹：默认 TERM 信号 + `-k 5` 秒 KILL 升级，
	// 对进程组发信号，能捎上 soffice 的子进程；找不到则原样跑 soffice（仅 Go 侧兜底）。
	name, cmdArgs, wrapped := c.Path, args, false
	if timeoutBin, lookErr := exec.LookPath("timeout"); lookErr == nil {
		secs := int64((c.Timeout + time.Second - 1) / time.Second)
		if secs < 1 {
			secs = 1
		}
		name = timeoutBin
		cmdArgs = append([]string{"-k", "5", strconv.FormatInt(secs, 10), c.Path}, args...)
		wrapped = true
	}

	// Go 侧兜底超时：timeout(1) 自身异常时放宽一段余量，避免抢在它前面误判
	backstop := c.Timeout
	if wrapped {
		backstop += 10 * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, backstop)
	defer cancel()

	cmd := exec.CommandContext(runCtx, name, cmdArgs...)
	output, runErr := cmd.CombinedOutput()
	if runErr == nil {
		return readPDFOutput(outDir)
	}
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return nil, ErrSofficeTimeout
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		// 经 timeout 包裹时的超时退出码：124（超时 TERM）、137（KILL 升级）、
		// 125（timeout 自身异常路径，功能上进程仍被杀）
		if wrapped && (exitErr.ExitCode() == 124 || exitErr.ExitCode() == 137 || exitErr.ExitCode() == 125) {
			return nil, ErrSofficeTimeout
		}
		detail := strings.TrimSpace(string(output))
		if detail != "" {
			runes := []rune(detail)
			if len(runes) > 200 {
				runes = runes[:200]
			}
			return nil, &ConvertFailedError{Detail: fmt.Sprintf("退出码 %d: %s", exitErr.ExitCode(), string(runes))}
		}
		return nil, &ConvertFailedError{}
	}
	return nil, &ConvertFailedError{Detail: runErr.Error()}
}

func readPDFOutput(outDir string) ([]byte, error) {
	matches, err := fs.Glob(os.DirFS(outDir), "*.pdf")
	if err != nil || len(matches) == 0 {
		return nil, ErrSofficeNoOutput
	}
	data, err := os.ReadFile(filepath.Join(outDir, matches[0]))
	if err != nil {
		return nil, ErrSofficeNoOutput
	}
	if !strings.HasPrefix(string(data), "%PDF") {
		return nil, ErrSofficeNoOutput
	}
	return data, nil
}
