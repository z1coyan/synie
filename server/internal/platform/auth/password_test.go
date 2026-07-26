package auth

import "testing"

func TestPasswordHasher(t *testing.T) {
	hasher := NewPasswordHasher(Argon2Params{Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32})
	hash, err := hasher.Hash("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if hash[:10] != "$argon2id$" {
		t.Fatalf("unexpected hash: %s", hash)
	}
	ok, err := hasher.Verify(hash, "correct horse battery staple")
	if err != nil || !ok {
		t.Fatalf("correct password: ok=%v err=%v", ok, err)
	}
	ok, err = hasher.Verify(hash, "wrong")
	if err != nil || ok {
		t.Fatalf("wrong password: ok=%v err=%v", ok, err)
	}
}
