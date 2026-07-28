package market

import "fmt"

func (n *nullableText) Scan(src any) error {
	switch value := src.(type) {
	case nil:
		n.String, n.Valid = "", false
	case string:
		n.String, n.Valid = value, true
	case []byte:
		n.String, n.Valid = string(value), true
	default:
		return fmt.Errorf("unsupported nullable text value %T", src)
	}
	return nil
}
