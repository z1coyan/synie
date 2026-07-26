package files

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestS3StoragePresignedGetKeepsConfiguredPrefix(t *testing.T) {
	t.Parallel()
	store, err := NewS3Storage(
		"http://127.0.0.1:9000", "us-east-1", "synie-files", "/tenant-a/",
		"access-key", "secret-key", "s3",
	)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := store.PresignedGet(context.Background(), "/2026/07/合同.pdf", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(signed)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Host != "127.0.0.1:9000" ||
		!strings.Contains(parsed.EscapedPath(), "/synie-files/tenant-a/2026/07/") ||
		parsed.Query().Get("X-Amz-Signature") == "" {
		t.Fatalf("presigned URL = %s", signed)
	}
}
