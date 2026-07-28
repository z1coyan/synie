package authz

import "strings"

func Matches(permissions map[string]struct{}, code string) bool {
	for _, candidate := range Candidates(code) {
		if _, ok := permissions[candidate]; ok {
			return true
		}
	}
	return false
}

func Candidates(code string) []string {
	prefix, _, ok := strings.Cut(code, ":")
	if !ok {
		return []string{code, "*"}
	}
	candidates := []string{code, prefix + ":*"}
	if domain, _, ok := strings.Cut(prefix, "."); ok {
		candidates = append(candidates, domain+".*")
	}
	return append(candidates, "*")
}
