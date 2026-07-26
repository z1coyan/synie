package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/finance/banking"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func financeBankingActor(
	s *Server,
	w http.ResponseWriter,
	r *http.Request,
	permissions ...string,
) (*authz.Actor, bool) {
	actor, err := requireActor(r)
	if err != nil {
		s.writeError(w, r, err)
		return nil, false
	}
	for _, permission := range permissions {
		if !actor.HasPermission(permission) {
			s.writeError(w, r, apierror.New(apierror.CodeForbidden, "无权执行此操作"))
			return nil, false
		}
	}
	return actor, true
}

func bankingOptional[T any](
	fields map[string]json.RawMessage,
	key string,
	value *T,
) banking.Optional[T] {
	_, set := fields[key]
	return banking.Optional[T]{Set: set, Value: value}
}

func bankingOptionalDecimal(
	fields map[string]json.RawMessage,
	key string,
	value *string,
) (banking.Optional[decimal.Decimal], error) {
	_, set := fields[key]
	if !set || value == nil {
		return banking.Optional[decimal.Decimal]{Set: set}, nil
	}
	parsed, err := decimalInput(*value, "银行业务", key)
	if err != nil {
		return banking.Optional[decimal.Decimal]{}, err
	}
	return banking.Optional[decimal.Decimal]{Set: true, Value: &parsed}, nil
}

func bankingEnumPointer[T ~string](value *T) *string {
	if value == nil {
		return nil
	}
	converted := string(*value)
	return &converted
}

func (s *Server) QueryFinanceBankAccounts(w http.ResponseWriter, r *http.Request) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_account:read")
	if !ok {
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := s.financeBanking.QueryBankAccounts(r.Context(), actor, financeBankingList(body))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetFinanceBankAccount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_account:read")
	if !ok {
		return
	}
	item, err := s.financeBanking.GetBankAccount(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateFinanceBankAccount(w http.ResponseWriter, r *http.Request) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_account:create")
	if !ok {
		return
	}
	var body gen.BankAccountCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.financeBanking.CreateBankAccount(r.Context(), actor, banking.BankAccountCreateInput{
		Alias: body.Alias, BankName: body.BankName, BranchName: body.BranchName,
		HolderName: body.HolderName, AccountNo: body.AccountNo, Active: body.Active,
		Note: body.Note, CompanyID: body.CompanyId, CurrencyID: body.CurrencyId,
		AccountID: body.AccountId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateFinanceBankAccount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_account:update")
	if !ok {
		return
	}
	var body gen.BankAccountUpdate
	fields, err := decodeFinanceJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.financeBanking.UpdateBankAccount(r.Context(), actor, id, banking.BankAccountUpdateInput{
		Alias: body.Alias, BankName: body.BankName, HolderName: body.HolderName,
		AccountNo: body.AccountNo, BranchName: bankingOptional(fields, "branchName", body.BranchName),
		Note: bankingOptional(fields, "note", body.Note), Active: body.Active,
		CurrencyID: body.CurrencyId, AccountID: bankingOptional(fields, "accountId", body.AccountId),
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteFinanceBankAccount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_account:delete")
	if !ok {
		return
	}
	if err := s.financeBanking.DeleteBankAccount(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryFinanceBankTransactions(w http.ResponseWriter, r *http.Request) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:read")
	if !ok {
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := s.financeBanking.QueryBankTransactions(
		r.Context(), actor, financeBankingList(body),
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetFinanceBankTransaction(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:read")
	if !ok {
		return
	}
	item, err := s.financeBanking.GetBankTransaction(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateFinanceBankTransaction(w http.ResponseWriter, r *http.Request) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:create")
	if !ok {
		return
	}
	var body gen.BankTransactionCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	income, err := optionalDecimalInput(body.Income, "银行流水", "income")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	expense, err := optionalDecimalInput(body.Expense, "银行流水", "expense")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	balance, err := optionalDecimalInput(body.Balance, "银行流水", "balance")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.financeBanking.CreateBankTransaction(
		r.Context(), actor, banking.BankTransactionCreateInput{
			OccurredAt: body.OccurredAt, Income: income, Expense: expense, Balance: balance,
			CounterpartyName:    body.CounterpartyName,
			CounterpartyAccount: body.CounterpartyAccount,
			Summary:             body.Summary, Note: body.Note, CompanyID: body.CompanyId,
			BankAccountID: body.BankAccountId,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateFinanceBankTransaction(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:update")
	if !ok {
		return
	}
	var body gen.BankTransactionUpdate
	fields, err := decodeFinanceJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	income, err := bankingOptionalDecimal(fields, "income", body.Income)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	expense, err := bankingOptionalDecimal(fields, "expense", body.Expense)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	balance, err := bankingOptionalDecimal(fields, "balance", body.Balance)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.financeBanking.UpdateBankTransaction(
		r.Context(), actor, id, banking.BankTransactionUpdateInput{
			OccurredAt: body.OccurredAt, Income: income, Expense: expense, Balance: balance,
			CounterpartyName: bankingOptional(
				fields, "counterpartyName", body.CounterpartyName,
			),
			CounterpartyAccount: bankingOptional(
				fields, "counterpartyAccount", body.CounterpartyAccount,
			),
			Summary:       bankingOptional(fields, "summary", body.Summary),
			Note:          bankingOptional(fields, "note", body.Note),
			BankAccountID: body.BankAccountId,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteFinanceBankTransaction(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:delete")
	if !ok {
		return
	}
	if err := s.financeBanking.DeleteBankTransaction(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryFinanceBankImportTemplates(w http.ResponseWriter, r *http.Request) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_import_template:read")
	if !ok {
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := s.financeBanking.QueryBankImportTemplates(
		r.Context(), actor, financeBankingList(body),
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetFinanceBankImportTemplate(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_import_template:read")
	if !ok {
		return
	}
	item, err := s.financeBanking.GetBankImportTemplate(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateFinanceBankImportTemplate(w http.ResponseWriter, r *http.Request) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_import_template:create")
	if !ok {
		return
	}
	var body gen.BankImportTemplateCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var startRow int64
	if body.StartRow != nil {
		startRow = int64(*body.StartRow)
	}
	item, err := s.financeBanking.CreateBankImportTemplate(
		r.Context(), actor, banking.BankImportTemplateCreateInput{
			Name: body.Name, StartRow: startRow,
			DatetimeCol:    body.DatetimeCol,
			DatetimeFormat: bankingEnumPointer(body.DatetimeFormat),
			DateCol:        body.DateCol, DateFormat: bankingEnumPointer(body.DateFormat),
			TimeCol: body.TimeCol, TimeFormat: bankingEnumPointer(body.TimeFormat),
			IncomeCol: body.IncomeCol, ExpenseCol: body.ExpenseCol,
			AmountCol: body.AmountCol, BalanceCol: body.BalanceCol,
			CounterpartyNameCol:    body.CounterpartyNameCol,
			CounterpartyAccountCol: body.CounterpartyAccountCol,
			SummaryCol:             body.SummaryCol, NoteCol: body.NoteCol,
			CompanyID: body.CompanyId, BankAccountID: body.BankAccountId,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateFinanceBankImportTemplate(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_import_template:update")
	if !ok {
		return
	}
	var body gen.BankImportTemplateUpdate
	fields, err := decodeFinanceJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var startRow *int64
	if body.StartRow != nil {
		value := int64(*body.StartRow)
		startRow = &value
	}
	item, err := s.financeBanking.UpdateBankImportTemplate(
		r.Context(), actor, id, banking.BankImportTemplateUpdateInput{
			Name: body.Name, StartRow: startRow,
			DatetimeCol: bankingOptional(fields, "datetimeCol", body.DatetimeCol),
			DatetimeFormat: bankingOptional(
				fields, "datetimeFormat", bankingEnumPointer(body.DatetimeFormat),
			),
			DateCol: bankingOptional(fields, "dateCol", body.DateCol),
			DateFormat: bankingOptional(
				fields, "dateFormat", bankingEnumPointer(body.DateFormat),
			),
			TimeCol: bankingOptional(fields, "timeCol", body.TimeCol),
			TimeFormat: bankingOptional(
				fields, "timeFormat", bankingEnumPointer(body.TimeFormat),
			),
			IncomeCol:  bankingOptional(fields, "incomeCol", body.IncomeCol),
			ExpenseCol: bankingOptional(fields, "expenseCol", body.ExpenseCol),
			AmountCol:  bankingOptional(fields, "amountCol", body.AmountCol),
			BalanceCol: bankingOptional(fields, "balanceCol", body.BalanceCol),
			CounterpartyNameCol: bankingOptional(
				fields, "counterpartyNameCol", body.CounterpartyNameCol,
			),
			CounterpartyAccountCol: bankingOptional(
				fields, "counterpartyAccountCol", body.CounterpartyAccountCol,
			),
			SummaryCol:    bankingOptional(fields, "summaryCol", body.SummaryCol),
			NoteCol:       bankingOptional(fields, "noteCol", body.NoteCol),
			BankAccountID: body.BankAccountId,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteFinanceBankImportTemplate(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_import_template:delete")
	if !ok {
		return
	}
	if err := s.financeBanking.DeleteBankImportTemplate(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryFinanceBankImports(w http.ResponseWriter, r *http.Request) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:import")
	if !ok {
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := s.financeBanking.QueryBankImports(r.Context(), actor, financeBankingList(body))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetFinanceBankImport(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:import")
	if !ok {
		return
	}
	item, err := s.financeBanking.GetBankImport(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateFinanceBankImport(w http.ResponseWriter, r *http.Request) {
	actor, ok := financeBankingActor(
		s, w, r, "acc.bank_transaction:import", "sys.file:read",
	)
	if !ok {
		return
	}
	var body gen.BankImportCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.financeBanking.CreateBankImport(r.Context(), actor, banking.BankImportCreateInput{
		CompanyID: body.CompanyId, BankAccountID: body.BankAccountId,
		TemplateID: body.TemplateId, FileID: body.FileId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) ImportFinanceBankImport(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := financeBankingActor(
		s, w, r, "acc.bank_transaction:import", "acc.bank_transaction:create",
	)
	if !ok {
		return
	}
	item, err := s.financeBanking.ImportBankImport(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteFinanceBankImport(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:import")
	if !ok {
		return
	}
	if err := s.financeBanking.DeleteBankImport(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryFinanceBankImportItems(w http.ResponseWriter, r *http.Request) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:import")
	if !ok {
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := s.financeBanking.QueryBankImportItems(
		r.Context(), actor, financeBankingList(body),
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetFinanceBankImportItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:import")
	if !ok {
		return
	}
	item, err := s.financeBanking.GetBankImportItem(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) UpdateFinanceBankImportItem(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:import")
	if !ok {
		return
	}
	var body gen.BankImportItemUpdate
	fields, err := decodeFinanceJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	income, err := bankingOptionalDecimal(fields, "income", body.Income)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	expense, err := bankingOptionalDecimal(fields, "expense", body.Expense)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	balance, err := bankingOptionalDecimal(fields, "balance", body.Balance)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.financeBanking.UpdateBankImportItem(
		r.Context(), actor, id, banking.BankImportItemUpdateInput{
			OccurredAt: body.OccurredAt, Income: income, Expense: expense, Balance: balance,
			CounterpartyName: bankingOptional(
				fields, "counterpartyName", body.CounterpartyName,
			),
			CounterpartyAccount: bankingOptional(
				fields, "counterpartyAccount", body.CounterpartyAccount,
			),
			Summary: bankingOptional(fields, "summary", body.Summary),
			Note:    bankingOptional(fields, "note", body.Note),
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteFinanceBankImportItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:import")
	if !ok {
		return
	}
	if err := s.financeBanking.DeleteBankImportItem(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryFinanceBankReconciliations(w http.ResponseWriter, r *http.Request) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:read")
	if !ok {
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := s.financeBanking.QueryBankReconciliations(
		r.Context(), actor, financeBankingList(body),
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetFinanceBankReconciliation(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:read")
	if !ok {
		return
	}
	item, err := s.financeBanking.GetBankReconciliation(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateFinanceBankReconciliation(w http.ResponseWriter, r *http.Request) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:reconcile")
	if !ok {
		return
	}
	var body gen.BankReconciliationCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	amount, err := decimalInput(body.Amount, "银行对账", "amount")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.financeBanking.CreateBankReconciliation(
		r.Context(), actor, banking.BankReconciliationCreateInput{
			BankTransactionID: body.BankTransactionId, JournalID: body.JournalId,
			Amount: amount,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) QuickCreateFinanceBankReconciliation(w http.ResponseWriter, r *http.Request) {
	actor, ok := financeBankingActor(
		s, w, r,
		"acc.bank_transaction:reconcile", "acc.gl_journal:create", "acc.gl_journal:audit",
	)
	if !ok {
		return
	}
	var body gen.BankReconciliationQuickCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	amount, err := decimalInput(body.Amount, "银行对账", "amount")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.financeBanking.QuickCreateBankReconciliation(
		r.Context(), actor, banking.QuickReconciliationInput{
			BankTransactionID: body.BankTransactionId,
			CounterAccountID:  body.CounterAccountId, Amount: amount,
			Summary: body.Summary, PostingDate: body.PostingDate.Time,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) GetFinanceBankReconciliationRemaining(
	w http.ResponseWriter,
	r *http.Request,
	params gen.GetFinanceBankReconciliationRemainingParams,
) {
	actor, ok := financeBankingActor(
		s, w, r, "acc.bank_transaction:read", "acc.gl_journal:read",
	)
	if !ok {
		return
	}
	amount, err := s.financeBanking.RemainingBankReconciliation(
		r.Context(), actor, params.BankTransactionId, params.JournalId,
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, gen.BankReconciliationRemaining{Amount: amount.String()})
}

func (s *Server) DeleteFinanceBankReconciliation(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, ok := financeBankingActor(s, w, r, "acc.bank_transaction:reconcile")
	if !ok {
		return
	}
	if err := s.financeBanking.DeleteBankReconciliation(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
