package files

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

var ErrObjectNotFound = errors.New("stored object not found")

type ObjectStorage interface {
	Put(context.Context, string, string) error
	Read(context.Context, string) ([]byte, error)
	Delete(context.Context, string) error
	PresignedGet(context.Context, string, time.Duration) (string, error)
}

type LocalStorage struct{ Root string }

func (s LocalStorage) Put(_ context.Context, key, source string) error {
	destination, err := localPath(s.Root, key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o750); err != nil {
		return err
	}
	src, err := os.Open(source)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(dst, src)
	closeErr := dst.Close()
	if copyErr != nil {
		_ = os.Remove(destination)
		return copyErr
	}
	return closeErr
}

func (s LocalStorage) Read(_ context.Context, key string) ([]byte, error) {
	path, err := localPath(s.Root, key)
	if err != nil {
		return nil, err
	}
	value, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrObjectNotFound
	}
	return value, err
}

func (s LocalStorage) Delete(_ context.Context, key string) error {
	path, err := localPath(s.Root, key)
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s LocalStorage) PresignedGet(context.Context, string, time.Duration) (string, error) {
	return "", errors.ErrUnsupported
}

func localPath(root, key string) (string, error) {
	if strings.TrimSpace(root) == "" || strings.TrimSpace(key) == "" {
		return "", errors.New("storage root and key are required")
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	path, err := filepath.Abs(filepath.Join(absoluteRoot, filepath.FromSlash(key)))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(absoluteRoot, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", errors.New("invalid object key")
	}
	return path, nil
}

type S3Storage struct {
	Client *minio.Client
	Bucket string
	Prefix string
}

func NewS3Storage(endpoint, region, bucket, prefix, accessKeyID, secretAccessKey, kind string) (*S3Storage, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, fmt.Errorf("invalid S3 endpoint")
	}
	lookup := minio.BucketLookupPath
	if strings.EqualFold(kind, "oss") {
		lookup = minio.BucketLookupDNS
	}
	client, err := minio.New(parsed.Host, &minio.Options{
		Creds:        credentials.NewStaticV4(accessKeyID, secretAccessKey, ""),
		Secure:       parsed.Scheme == "https",
		Region:       region,
		BucketLookup: lookup,
	})
	if err != nil {
		return nil, err
	}
	return &S3Storage{Client: client, Bucket: bucket, Prefix: strings.Trim(prefix, "/")}, nil
}

func (s *S3Storage) fullKey(key string) string {
	key = strings.TrimLeft(key, "/")
	if s.Prefix == "" {
		return key
	}
	return s.Prefix + "/" + key
}

func (s *S3Storage) Put(ctx context.Context, key, source string) error {
	stat, err := os.Stat(source)
	if err != nil {
		return err
	}
	reader, err := os.Open(source)
	if err != nil {
		return err
	}
	defer reader.Close()
	_, err = s.Client.PutObject(ctx, s.Bucket, s.fullKey(key), reader, stat.Size(), minio.PutObjectOptions{})
	return err
}

func (s *S3Storage) Read(ctx context.Context, key string) ([]byte, error) {
	object, err := s.Client.GetObject(ctx, s.Bucket, s.fullKey(key), minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer object.Close()
	value, err := io.ReadAll(object)
	if err != nil {
		response := minio.ToErrorResponse(err)
		if response.StatusCode == 404 || response.Code == "NoSuchKey" || response.Code == "NoSuchObject" {
			return nil, ErrObjectNotFound
		}
	}
	return value, err
}

func (s *S3Storage) Delete(ctx context.Context, key string) error {
	return s.Client.RemoveObject(ctx, s.Bucket, s.fullKey(key), minio.RemoveObjectOptions{})
}

func (s *S3Storage) PresignedGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	u, err := s.Client.PresignedGetObject(ctx, s.Bucket, s.fullKey(key), ttl, nil)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}
