package authz

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type permissionFixture struct {
	Cases []struct {
		Name        string   `json:"name"`
		Permissions []string `json:"permissions"`
		Code        string   `json:"code"`
		Matches     bool     `json:"matches"`
	} `json:"cases"`
}

func TestMatchesContract(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "contracts", "fixtures", "authz", "permission_matches.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture permissionFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}

	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			perms := make(map[string]struct{}, len(tc.Permissions))
			for _, permission := range tc.Permissions {
				perms[permission] = struct{}{}
			}
			if got := Matches(perms, tc.Code); got != tc.Matches {
				t.Fatalf("Matches() = %v, want %v", got, tc.Matches)
			}
		})
	}
}
