package printing

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// 假 soffice 脚本：解析 --outdir，按模式产出/失败/挂起（对齐 Elixir 假可执行测试模式）。
func fakeSoffice(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-soffice.sh")
	script := "#!/bin/sh\nout=\"\"\nwhile [ $# -gt 0 ]; do\n" +
		"  case \"$1\" in --outdir) out=\"$2\"; shift 2;; *) shift;; esac\n" +
		"done\n" + body
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSofficeConverterSuccess(t *testing.T) {
	t.Parallel()
	path := fakeSoffice(t, "printf '%s' '%PDF-1.4 fake' > \"$out/doc.pdf\"\nexit 0\n")
	converter := NewSofficeConverter(path, 5*time.Second, 1)
	pdf, err := converter.ConvertXlsxToPDF(context.Background(), []byte("fake-xlsx"))
	if err != nil {
		t.Fatal(err)
	}
	if string(pdf) != "%PDF-1.4 fake" {
		t.Fatalf("pdf = %q", pdf)
	}
}

func TestSofficeConverterNotFound(t *testing.T) {
	t.Parallel()
	converter := NewSofficeConverter(filepath.Join(t.TempDir(), "no-such-soffice"), time.Second, 1)
	_, err := converter.ConvertXlsxToPDF(context.Background(), []byte("x"))
	if !errors.Is(err, ErrSofficeNotFound) {
		t.Fatalf("err = %v, want ErrSofficeNotFound", err)
	}
}

func TestSofficeConverterConvertFailed(t *testing.T) {
	t.Parallel()
	path := fakeSoffice(t, "echo 'broken file' >&2\nexit 3\n")
	converter := NewSofficeConverter(path, 5*time.Second, 1)
	_, err := converter.ConvertXlsxToPDF(context.Background(), []byte("x"))
	var failed *ConvertFailedError
	if !errors.As(err, &failed) {
		t.Fatalf("err = %v, want ConvertFailedError", err)
	}
	if failed.Detail == "" {
		t.Fatal("ConvertFailedError 缺少细节")
	}
}

func TestSofficeConverterNoOutput(t *testing.T) {
	t.Parallel()
	path := fakeSoffice(t, "exit 0\n")
	converter := NewSofficeConverter(path, 5*time.Second, 1)
	_, err := converter.ConvertXlsxToPDF(context.Background(), []byte("x"))
	if !errors.Is(err, ErrSofficeNoOutput) {
		t.Fatalf("err = %v, want ErrSofficeNoOutput", err)
	}
}

func TestSofficeConverterTimeoutKillsProcess(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("timeout"); err != nil {
		t.Skip("系统无 timeout(1)，跳过进程组杀除断言")
	}
	pidFile := filepath.Join(t.TempDir(), "pid")
	path := fakeSoffice(t, "echo $$ > \""+pidFile+"\"\nsleep 60\n")
	converter := NewSofficeConverter(path, time.Second, 1)
	start := time.Now()
	_, err := converter.ConvertXlsxToPDF(context.Background(), []byte("x"))
	if !errors.Is(err, ErrSofficeTimeout) {
		t.Fatalf("err = %v, want ErrSofficeTimeout", err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("超时路径耗时 %v，进程未被及时终止", elapsed)
	}
	// 假进程应已被 timeout(1) 杀死
	raw, readErr := os.ReadFile(pidFile)
	if readErr != nil {
		t.Skip("假进程未写 pid 文件，跳过杀除断言")
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if killErr := exec.Command("kill", "-0", string(raw)).Run(); killErr != nil {
			return // 进程已死
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("超时后假进程仍存活")
}

func TestSofficeConverterConcurrencyLimit(t *testing.T) {
	t.Parallel()
	path := fakeSoffice(t, "sleep 0.3\nprintf '%s' '%PDF' > \"$out/doc.pdf\"\n")
	converter := NewSofficeConverter(path, 10*time.Second, 1)
	start := time.Now()
	done := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			_, err := converter.ConvertXlsxToPDF(context.Background(), []byte("x"))
			done <- err
		}()
	}
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	// maxConcurrency=1 时两次转换串行，总耗时应 ≥ 两次单次耗时（留调度裕量）
	if elapsed := time.Since(start); elapsed < 500*time.Millisecond {
		t.Fatalf("并发限流未生效，两次转换总耗时 %v", elapsed)
	}
}
