package httpapi

import (
	"net/http"

	"github.com/z1coyan/synie/server/internal/domain/finance/banking"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// financeBankingActor 要求 actor 同时具备 permissions 中的全部权限。
func (s *Server) financeBankingActor(
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

func bankingEnumPointer[T ~string](value *T) *string {
	if value == nil {
		return nil
	}
	converted := string(*value)
	return &converted
}

func (s *Server) QueryFinanceBankAccounts(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "acc.bank_account:read", financeBankingList,
		s.FinanceBanking.QueryBankAccounts, passthroughListResponse)
}

func (s *Server) GetFinanceBankAccount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_account:read")
	if !ok {
		return
	}
	item, err := s.FinanceBanking.GetBankAccount(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateFinanceBankAccount(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_account:create")
	if !ok {
		return
	}
	var body gen.BankAccountCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.FinanceBanking.CreateBankAccount(r.Context(), actor, banking.BankAccountCreateInput{
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
	actor, ok := s.financeBankingActor(w, r, "acc.bank_account:update")
	if !ok {
		return
	}
	var body gen.BankAccountUpdate
	fields, err := decodePatchJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.FinanceBanking.UpdateBankAccount(r.Context(), actor, id, banking.BankAccountUpdateInput{
		Alias: body.Alias, BankName: body.BankName, HolderName: body.HolderName,
		AccountNo: body.AccountNo, BranchName: optionalField(fields, "branchName", body.BranchName),
		Note: optionalField(fields, "note", body.Note), Active: body.Active,
		CurrencyID: body.CurrencyId, AccountID: optionalField(fields, "accountId", body.AccountId),
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteFinanceBankAccount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_account:delete")
	if !ok {
		return
	}
	if err := s.FinanceBanking.DeleteBankAccount(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryFinanceBankTransactions(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "acc.bank_transaction:read", financeBankingList,
		s.FinanceBanking.QueryBankTransactions, passthroughListResponse)
}

func (s *Server) GetFinanceBankTransaction(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_transaction:read")
	if !ok {
		return
	}
	item, err := s.FinanceBanking.GetBankTransaction(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateFinanceBankTransaction(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_transaction:create")
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
	item, err := s.FinanceBanking.CreateBankTransaction(
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
	actor, ok := s.financeBankingActor(w, r, "acc.bank_transaction:update")
	if !ok {
		return
	}
	var body gen.BankTransactionUpdate
	fields, err := decodePatchJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	income, err := optionalDecimalField(fields, "income", body.Income, "银行业务")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	expense, err := optionalDecimalField(fields, "expense", body.Expense, "银行业务")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	balance, err := optionalDecimalField(fields, "balance", body.Balance, "银行业务")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.FinanceBanking.UpdateBankTransaction(
		r.Context(), actor, id, banking.BankTransactionUpdateInput{
			OccurredAt: body.OccurredAt, Income: income, Expense: expense, Balance: balance,
			CounterpartyName: optionalField(
				fields, "counterpartyName", body.CounterpartyName,
			),
			CounterpartyAccount: optionalField(
				fields, "counterpartyAccount", body.CounterpartyAccount,
			),
			Summary:       optionalField(fields, "summary", body.Summary),
			Note:          optionalField(fields, "note", body.Note),
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
	actor, ok := s.financeBankingActor(w, r, "acc.bank_transaction:delete")
	if !ok {
		return
	}
	if err := s.FinanceBanking.DeleteBankTransaction(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryFinanceBankImportTemplates(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "acc.bank_import_template:read", financeBankingList,
		s.FinanceBanking.QueryBankImportTemplates, passthroughListResponse)
}

func (s *Server) GetFinanceBankImportTemplate(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_import_template:read")
	if !ok {
		return
	}
	item, err := s.FinanceBanking.GetBankImportTemplate(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateFinanceBankImportTemplate(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_import_template:create")
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
	item, err := s.FinanceBanking.CreateBankImportTemplate(
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
	actor, ok := s.financeBankingActor(w, r, "acc.bank_import_template:update")
	if !ok {
		return
	}
	var body gen.BankImportTemplateUpdate
	fields, err := decodePatchJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var startRow *int64
	if body.StartRow != nil {
		value := int64(*body.StartRow)
		startRow = &value
	}
	item, err := s.FinanceBanking.UpdateBankImportTemplate(
		r.Context(), actor, id, banking.BankImportTemplateUpdateInput{
			Name: body.Name, StartRow: startRow,
			DatetimeCol:            optionalField(fields, "datetimeCol", body.DatetimeCol),
			DatetimeFormat:         optionalEnumField(fields, "datetimeFormat", body.DatetimeFormat),
			DateCol:                optionalField(fields, "dateCol", body.DateCol),
			DateFormat:             optionalEnumField(fields, "dateFormat", body.DateFormat),
			TimeCol:                optionalField(fields, "timeCol", body.TimeCol),
			TimeFormat:             optionalEnumField(fields, "timeFormat", body.TimeFormat),
			IncomeCol:              optionalField(fields, "incomeCol", body.IncomeCol),
			ExpenseCol:             optionalField(fields, "expenseCol", body.ExpenseCol),
			AmountCol:              optionalField(fields, "amountCol", body.AmountCol),
			BalanceCol:             optionalField(fields, "balanceCol", body.BalanceCol),
			CounterpartyNameCol:    optionalField(fields, "counterpartyNameCol", body.CounterpartyNameCol),
			CounterpartyAccountCol: optionalField(fields, "counterpartyAccountCol", body.CounterpartyAccountCol),
			SummaryCol:             optionalField(fields, "summaryCol", body.SummaryCol),
			NoteCol:                optionalField(fields, "noteCol", body.NoteCol),
			BankAccountID:          body.BankAccountId,
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
	actor, ok := s.financeBankingActor(w, r, "acc.bank_import_template:delete")
	if !ok {
		return
	}
	if err := s.FinanceBanking.DeleteBankImportTemplate(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryFinanceBankImports(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "acc.bank_transaction:import", financeBankingList,
		s.FinanceBanking.QueryBankImports, passthroughListResponse)
}

func (s *Server) GetFinanceBankImport(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_transaction:import")
	if !ok {
		return
	}
	item, err := s.FinanceBanking.GetBankImport(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateFinanceBankImport(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.financeBankingActor(
		w, r, "acc.bank_transaction:import", "sys.file:read",
	)
	if !ok {
		return
	}
	var body gen.BankImportCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.FinanceBanking.CreateBankImport(r.Context(), actor, banking.BankImportCreateInput{
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
	actor, ok := s.financeBankingActor(
		w, r, "acc.bank_transaction:import", "acc.bank_transaction:create",
	)
	if !ok {
		return
	}
	item, err := s.FinanceBanking.ImportBankImport(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteFinanceBankImport(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_transaction:import")
	if !ok {
		return
	}
	if err := s.FinanceBanking.DeleteBankImport(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryFinanceBankImportItems(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "acc.bank_transaction:import", financeBankingList,
		s.FinanceBanking.QueryBankImportItems, passthroughListResponse)
}

func (s *Server) GetFinanceBankImportItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_transaction:import")
	if !ok {
		return
	}
	item, err := s.FinanceBanking.GetBankImportItem(r.Context(), actor, id)
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
	actor, ok := s.financeBankingActor(w, r, "acc.bank_transaction:import")
	if !ok {
		return
	}
	var body gen.BankImportItemUpdate
	fields, err := decodePatchJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	income, err := optionalDecimalField(fields, "income", body.Income, "银行业务")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	expense, err := optionalDecimalField(fields, "expense", body.Expense, "银行业务")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	balance, err := optionalDecimalField(fields, "balance", body.Balance, "银行业务")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.FinanceBanking.UpdateBankImportItem(
		r.Context(), actor, id, banking.BankImportItemUpdateInput{
			OccurredAt: body.OccurredAt, Income: income, Expense: expense, Balance: balance,
			CounterpartyName: optionalField(
				fields, "counterpartyName", body.CounterpartyName,
			),
			CounterpartyAccount: optionalField(
				fields, "counterpartyAccount", body.CounterpartyAccount,
			),
			Summary: optionalField(fields, "summary", body.Summary),
			Note:    optionalField(fields, "note", body.Note),
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteFinanceBankImportItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_transaction:import")
	if !ok {
		return
	}
	if err := s.FinanceBanking.DeleteBankImportItem(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryFinanceBankReconciliations(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "acc.bank_transaction:read", financeBankingList,
		s.FinanceBanking.QueryBankReconciliations, passthroughListResponse)
}

func (s *Server) GetFinanceBankReconciliation(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_transaction:read")
	if !ok {
		return
	}
	item, err := s.FinanceBanking.GetBankReconciliation(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateFinanceBankReconciliation(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.financeBankingActor(w, r, "acc.bank_transaction:reconcile")
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
	item, err := s.FinanceBanking.CreateBankReconciliation(
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
	actor, ok := s.financeBankingActor(
		w, r,
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
	item, err := s.FinanceBanking.QuickCreateBankReconciliation(
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
	actor, ok := s.financeBankingActor(
		w, r, "acc.bank_transaction:read", "acc.gl_journal:read",
	)
	if !ok {
		return
	}
	amount, err := s.FinanceBanking.RemainingBankReconciliation(
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
	actor, ok := s.financeBankingActor(w, r, "acc.bank_transaction:reconcile")
	if !ok {
		return
	}
	if err := s.FinanceBanking.DeleteBankReconciliation(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
