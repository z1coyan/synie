package files

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalStorageRoundTripAndTraversalGuard(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	source := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(source, []byte("文件字节"), 0o600); err != nil {
		t.Fatal(err)
	}

	store := LocalStorage{Root: root}
	ctx := context.Background()
	if err := store.Put(ctx, "2026/07/id.bin", source); err != nil {
		t.Fatal(err)
	}
	got, err := store.Read(ctx, "2026/07/id.bin")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "文件字节" {
		t.Fatalf("read = %q", got)
	}
	if err := store.Delete(ctx, "2026/07/id.bin"); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(ctx, "2026/07/id.bin"); err != nil {
		t.Fatalf("delete must be idempotent: %v", err)
	}
	if err := store.Put(ctx, "../escape.bin", source); err == nil {
		t.Fatal("traversal key unexpectedly accepted")
	}
}

func TestSafeExtensionNeverCopiesUserPath(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"合同.PDF":          ".pdf",
		"photo.jpeg":      ".jpeg",
		"evil.sh/../../x": "",
		"too.abcdefghijk": "",
		"无扩展名":            "",
	}
	for input, want := range cases {
		if got := safeExtension(input); got != want {
			t.Errorf("safeExtension(%q) = %q, want %q", input, got, want)
		}
	}
}
