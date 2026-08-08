-- 2026-08-08 全量基线：系统未上线，压平历史 00001–00024 全部迁移（开发库一律重建，不保留升级路径）。
-- 产出方式：scratch 库重放全部历史迁移后 pg_dump --schema-only --no-owner 导出（排除 migrate 运行时自建的 synie_schema_migration）。
-- 数据回填/清洗类历史迁移（00007/00008/00016 回填段/00017/00021/00022 回填段）对全新库无意义，随压平移除。
--
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.10
-- Dumped by pg_dump version 17.10 (Ubuntu 17.10-0ubuntu0.25.10.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET search_path = public, pg_catalog;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: acc_bank_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_bank_account (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alias text NOT NULL,
    bank_name text NOT NULL,
    branch_name text,
    holder_name text NOT NULL,
    account_no text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    note text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    currency_id uuid NOT NULL,
    account_id uuid
);


--
-- Name: acc_bank_import; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_bank_import (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'parsed'::text NOT NULL,
    error text,
    imported_at timestamp(0) without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    bank_account_id uuid NOT NULL,
    template_id uuid NOT NULL,
    file_id uuid NOT NULL,
    created_by_id uuid,
    imported_by_id uuid
);


--
-- Name: acc_bank_import_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_bank_import_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    row_no bigint NOT NULL,
    occurred_at timestamp(0) without time zone,
    income numeric,
    expense numeric,
    balance numeric,
    counterparty_name text,
    counterparty_account text,
    summary text,
    note text,
    error text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    import_id uuid NOT NULL,
    company_id uuid NOT NULL,
    transaction_id uuid
);


--
-- Name: acc_bank_import_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_bank_import_template (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    start_row bigint DEFAULT 2 NOT NULL,
    datetime_col text,
    datetime_format text,
    date_col text,
    date_format text,
    time_col text,
    time_format text,
    income_col text,
    expense_col text,
    amount_col text,
    balance_col text,
    counterparty_name_col text,
    counterparty_account_col text,
    summary_col text,
    note_col text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    bank_account_id uuid NOT NULL
);


--
-- Name: acc_bank_reconciliation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_bank_reconciliation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    amount numeric NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    bank_transaction_id uuid NOT NULL,
    journal_id uuid NOT NULL,
    CONSTRAINT positive_amount CHECK ((amount > (0)::numeric))
);


--
-- Name: acc_bank_transaction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_bank_transaction (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp(0) without time zone NOT NULL,
    income numeric,
    expense numeric,
    balance numeric,
    counterparty_name text,
    counterparty_account text,
    summary text,
    note text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    bank_account_id uuid NOT NULL,
    reconciled_amount numeric DEFAULT '0'::numeric NOT NULL,
    unreconciled_amount numeric DEFAULT '0'::numeric NOT NULL,
    reconcile_status text DEFAULT 'unreconciled'::text NOT NULL,
    CONSTRAINT single_sided_amount CHECK ((((income IS NULL) <> (expense IS NULL)) AND (COALESCE(income, expense) > (0)::numeric)))
);


--
-- Name: acc_bill; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_bill (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bill_no text NOT NULL,
    bill_kind text NOT NULL,
    issue_date date,
    due_date date NOT NULL,
    face_amount numeric,
    drawer_name text,
    drawer_account text,
    drawer_bank_name text,
    drawer_bank_no text,
    payee_name text,
    payee_account text,
    payee_bank_name text,
    payee_bank_no text,
    acceptor_name text,
    acceptor_account text,
    acceptor_bank_name text,
    acceptor_bank_no text,
    transferable boolean DEFAULT true NOT NULL,
    acceptance_date date,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: acc_bill_holding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_bill_holding (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bill_no text NOT NULL,
    sub_start bigint NOT NULL,
    sub_end bigint NOT NULL,
    amount numeric NOT NULL,
    due_date date NOT NULL,
    acquired_on date NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    bank_account_id uuid NOT NULL,
    bill_id uuid NOT NULL,
    source_transaction_id uuid NOT NULL
);


--
-- Name: acc_bill_transaction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_bill_transaction (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    doc_no text,
    transaction_type text NOT NULL,
    occurred_on date NOT NULL,
    sub_start bigint NOT NULL,
    sub_end bigint NOT NULL,
    amount numeric NOT NULL,
    party_type text,
    party_id uuid,
    discount_org text,
    discount_rate numeric,
    interest numeric,
    net_amount numeric,
    posting_date date,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    bank_account_id uuid NOT NULL,
    to_bank_account_id uuid,
    bill_id uuid,
    bill_account_id uuid,
    settle_account_id uuid,
    interest_account_id uuid,
    created_by_id uuid,
    audited_by_id uuid
);


--
-- Name: acc_expense_report; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_expense_report (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    doc_no text NOT NULL,
    expense_date date NOT NULL,
    posting_date date,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    payment_account_id uuid NOT NULL,
    created_by_id uuid,
    audited_by_id uuid
);


--
-- Name: acc_expense_report_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_expense_report_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    kind text NOT NULL,
    summary text,
    amount numeric,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    report_id uuid NOT NULL,
    company_id uuid NOT NULL,
    invoice_id uuid,
    expense_account_id uuid
);


--
-- Name: acc_gl_entry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_gl_entry (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint NOT NULL,
    posting_date date NOT NULL,
    debit numeric DEFAULT '0'::numeric NOT NULL,
    credit numeric DEFAULT '0'::numeric NOT NULL,
    party_type text,
    party_id uuid,
    voucher_type text NOT NULL,
    voucher_id uuid NOT NULL,
    voucher_no text NOT NULL,
    is_cancelled boolean DEFAULT false NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    account_id uuid NOT NULL,
    currency_id uuid,
    is_reversed boolean DEFAULT false NOT NULL,
    is_reversal boolean DEFAULT false NOT NULL,
    CONSTRAINT party_pair CHECK (((party_type IS NULL) = (party_id IS NULL))),
    CONSTRAINT single_sided_amount CHECK (((debit = (0)::numeric) <> (credit = (0)::numeric)))
);


--
-- Name: acc_gl_entry_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.acc_gl_entry_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: acc_gl_entry_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.acc_gl_entry_seq_seq OWNED BY public.acc_gl_entry.seq;


--
-- Name: acc_gl_journal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_gl_journal (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    voucher_no text NOT NULL,
    date date NOT NULL,
    posting_date date,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    submitted_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    created_by_id uuid,
    submitted_by_id uuid
);


--
-- Name: acc_gl_journal_line; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_gl_journal_line (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    debit numeric DEFAULT '0'::numeric NOT NULL,
    credit numeric DEFAULT '0'::numeric NOT NULL,
    party_type text,
    party_id uuid,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    journal_id uuid NOT NULL,
    company_id uuid NOT NULL,
    account_id uuid NOT NULL,
    currency_id uuid,
    CONSTRAINT at_most_one_side CHECK (((debit >= (0)::numeric) AND (credit >= (0)::numeric) AND (NOT ((debit > (0)::numeric) AND (credit > (0)::numeric))))),
    CONSTRAINT party_pair CHECK (((party_type IS NULL) = (party_id IS NULL)))
);


--
-- Name: acc_setting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_setting (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ocr_access_key_id text,
    ocr_access_key_secret text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: acc_vat_invoice; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acc_vat_invoice (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    doc_no text,
    direction text NOT NULL,
    invoice_date date,
    posting_date date,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    invoice_kind text NOT NULL,
    invoice_code text DEFAULT ''::text NOT NULL,
    invoice_no text,
    seller_name text,
    seller_tax_no text,
    seller_address_phone text,
    seller_bank_account text,
    buyer_name text,
    buyer_tax_no text,
    buyer_address_phone text,
    buyer_bank_account text,
    items jsonb[] DEFAULT ARRAY[]::jsonb[] NOT NULL,
    net_total numeric,
    tax_total numeric,
    gross_total numeric,
    issuer text,
    reviewer text,
    payee text,
    remarks text,
    red_invoice_no text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    party_account_id uuid,
    amount_account_id uuid,
    tax_account_id uuid,
    mirror_invoice_id uuid,
    created_by_id uuid,
    audited_by_id uuid,
    sal_reconciliation_id uuid,
    pur_reconciliation_id uuid
);


--
-- Name: auth_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_account (
    id text NOT NULL,
    user_id text NOT NULL,
    provider_id text NOT NULL,
    account_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_session (
    id text NOT NULL,
    user_id text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_user (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    username text,
    display_username text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bas_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bas_account (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    direction text NOT NULL,
    is_group boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    parent_id uuid,
    company_id uuid NOT NULL,
    currency_id uuid,
    role text
);


--
-- Name: bas_company; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bas_company (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    parent_id uuid,
    short_name text NOT NULL,
    base_currency_id uuid NOT NULL
);


--
-- Name: bas_currency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bas_currency (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    iso_code text NOT NULL,
    symbol text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    active boolean DEFAULT true NOT NULL
);


--
-- Name: bas_market_instrument; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bas_market_instrument (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    source_type text NOT NULL,
    default_price_kind text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    note text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    currency_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    fetch_enabled boolean DEFAULT false NOT NULL,
    external_last_code text,
    external_product_group text
);


--
-- Name: bas_market_price_point; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bas_market_price_point (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    observed_at timestamp(0) without time zone NOT NULL,
    price numeric NOT NULL,
    price_kind text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    is_voided boolean DEFAULT false NOT NULL,
    note text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    instrument_id uuid NOT NULL,
    currency_id uuid NOT NULL,
    unit_id uuid NOT NULL
);


--
-- Name: bas_party_address; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bas_party_address (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    name text NOT NULL,
    purpose text NOT NULL,
    contact_name text,
    contact_phone text,
    address text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    province text DEFAULT ''::text NOT NULL,
    city text DEFAULT ''::text NOT NULL,
    district text DEFAULT ''::text NOT NULL,
    CONSTRAINT bas_party_address_address_nonempty CHECK ((length(btrim(address)) > 0)),
    CONSTRAINT bas_party_address_name_nonempty CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT bas_party_address_party_type_check CHECK ((party_type = ANY (ARRAY['customer'::text, 'supplier'::text, 'company'::text]))),
    CONSTRAINT bas_party_address_purpose_check CHECK ((purpose = ANY (ARRAY['shipping'::text, 'office'::text, 'other'::text])))
);


--
-- Name: bas_unit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bas_unit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unit_type text NOT NULL,
    is_base boolean DEFAULT false NOT NULL,
    name text NOT NULL,
    symbol text NOT NULL,
    ratio numeric NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: hr_attendance_correction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_attendance_correction (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    date date NOT NULL,
    times time(0) without time zone[] NOT NULL,
    note text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    employee_id uuid NOT NULL,
    created_by_id uuid
);


--
-- Name: hr_attendance_day; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_attendance_day (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    date date NOT NULL,
    morning_in time(0) without time zone,
    morning_out time(0) without time zone,
    afternoon_in time(0) without time zone,
    afternoon_out time(0) without time zone,
    normal_hours numeric NOT NULL,
    overtime_hours numeric NOT NULL,
    bonus_workday numeric NOT NULL,
    status text NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    employee_id uuid NOT NULL
);


--
-- Name: hr_attendance_import; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_attendance_import (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'parsed'::text NOT NULL,
    error text,
    total_rows bigint,
    bad_rows bigint,
    dup_rows bigint,
    matched_rows bigint,
    unmatched_rows bigint,
    unmatched_detail text,
    imported_count bigint,
    skipped_existing_rows bigint,
    skipped_unmatched_rows bigint,
    auto_created_count bigint,
    imported_at timestamp(0) without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    file_id uuid NOT NULL,
    created_by_id uuid,
    imported_by_id uuid
);


--
-- Name: hr_attendance_punch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_attendance_punch (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attendance_no text NOT NULL,
    punched_at timestamp(0) without time zone NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    employee_id uuid NOT NULL,
    import_id uuid NOT NULL
);


--
-- Name: hr_employee_loan; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_employee_loan (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    occurred_on date NOT NULL,
    amount numeric NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    employee_id uuid NOT NULL,
    payroll_id uuid,
    created_by_id uuid
);


--
-- Name: hr_employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    attendance_no text,
    id_number text,
    household_registration text,
    phone text,
    current_address text,
    daily_wage numeric,
    monthly_allowance numeric,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    insurance_types text[] DEFAULT ARRAY[]::text[] NOT NULL
);


--
-- Name: hr_payroll; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_payroll (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    month text NOT NULL,
    workdays numeric DEFAULT '0'::numeric NOT NULL,
    attendance_days bigint DEFAULT 0 NOT NULL,
    missing_days bigint DEFAULT 0 NOT NULL,
    overtime_hours numeric DEFAULT '0'::numeric NOT NULL,
    daily_wage numeric DEFAULT '0'::numeric NOT NULL,
    base_amount numeric DEFAULT '0'::numeric NOT NULL,
    allowance numeric DEFAULT '0'::numeric NOT NULL,
    bonus numeric DEFAULT '0'::numeric NOT NULL,
    fine numeric DEFAULT '0'::numeric NOT NULL,
    loan_deduction numeric DEFAULT '0'::numeric NOT NULL,
    payable numeric DEFAULT '0'::numeric NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    employee_id uuid NOT NULL
);


--
-- Name: hr_payroll_payment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_payroll_payment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    month text,
    paid_on date NOT NULL,
    amount numeric NOT NULL,
    kind text DEFAULT 'normal'::text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    payroll_id uuid NOT NULL,
    employee_id uuid,
    created_by_id uuid
);


--
-- Name: inv_material; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_material (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    spec text,
    customer_part_no text,
    active boolean DEFAULT true NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    category_id uuid NOT NULL,
    default_unit_id uuid NOT NULL,
    is_customer_material boolean DEFAULT false NOT NULL,
    customer_id uuid,
    material_type text DEFAULT 'STOCK'::text NOT NULL,
    CONSTRAINT customer_material_pair CHECK ((((is_customer_material = false) AND (customer_id IS NULL)) OR ((is_customer_material = true) AND (customer_id IS NOT NULL)))),
    CONSTRAINT inv_material_material_type_check CHECK ((material_type = ANY (ARRAY['STOCK'::text, 'VIRTUAL'::text, 'ASSET'::text])))
);


--
-- Name: inv_material_category; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_material_category (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    is_leaf boolean DEFAULT true NOT NULL,
    active boolean DEFAULT true NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    parent_id uuid
);


--
-- Name: inv_material_unit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_material_unit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    factor numeric NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL
);


--
-- Name: inv_stock_count; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_stock_count (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    doc_no text NOT NULL,
    posting_date date DEFAULT CURRENT_DATE NOT NULL,
    summary text,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    snapshot_taken_at timestamp without time zone NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    created_by_id uuid,
    audited_by_id uuid
);


--
-- Name: inv_stock_count_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_stock_count_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    counted_quantity numeric,
    converted_counted numeric,
    book_quantity numeric DEFAULT '0'::numeric NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    unit_name text NOT NULL,
    remark text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    count_id uuid NOT NULL,
    company_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    CONSTRAINT counted_quantity_nonnegative CHECK ((counted_quantity >= (0)::numeric))
);


--
-- Name: inv_stock_doc; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_stock_doc (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    doc_no text NOT NULL,
    direction text NOT NULL,
    doc_date date DEFAULT CURRENT_DATE NOT NULL,
    summary text,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    created_by_id uuid,
    audited_by_id uuid
);


--
-- Name: inv_stock_doc_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_stock_doc_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    unit_name text NOT NULL,
    remark text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    stock_doc_id uuid NOT NULL,
    company_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric))
);


--
-- Name: inv_stock_entry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_stock_entry (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint NOT NULL,
    quantity numeric NOT NULL,
    posting_date date NOT NULL,
    voucher_type text NOT NULL,
    voucher_id uuid NOT NULL,
    voucher_no text NOT NULL,
    is_cancelled boolean DEFAULT false NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    material_id uuid NOT NULL,
    cancelled_at timestamp without time zone,
    CONSTRAINT quantity_nonzero CHECK ((quantity <> (0)::numeric))
);


--
-- Name: inv_stock_entry_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inv_stock_entry_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inv_stock_entry_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inv_stock_entry_seq_seq OWNED BY public.inv_stock_entry.seq;


--
-- Name: inv_stock_transfer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_stock_transfer (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    doc_no text NOT NULL,
    doc_date date DEFAULT CURRENT_DATE NOT NULL,
    summary text,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    shipped_at timestamp without time zone,
    received_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    from_warehouse_id uuid NOT NULL,
    to_warehouse_id uuid NOT NULL,
    transit_warehouse_id uuid NOT NULL,
    created_by_id uuid,
    shipped_by_id uuid,
    received_by_id uuid
);


--
-- Name: inv_stock_transfer_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_stock_transfer_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    received_qty numeric,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    unit_name text NOT NULL,
    remark text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    stock_transfer_id uuid NOT NULL,
    company_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric))
);


--
-- Name: inv_warehouse; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_warehouse (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    is_leaf boolean DEFAULT true NOT NULL,
    active boolean DEFAULT true NOT NULL,
    is_outsourced boolean DEFAULT false NOT NULL,
    allow_negative boolean DEFAULT false NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    parent_id uuid,
    account_id uuid,
    party_type text,
    party_id uuid,
    code text NOT NULL,
    CONSTRAINT party_pair CHECK (((party_type IS NULL) = (party_id IS NULL)))
);


--
-- Name: COLUMN inv_warehouse.code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inv_warehouse.code IS '仓库编码：系统按编号规则生成（公司内唯一），创建后不可改，不接受手填';


--
-- Name: mfg_bom; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_bom (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    note text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    material_id uuid NOT NULL,
    code text NOT NULL,
    plan_name text,
    status text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT mfg_bom_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'inactive'::text])))
);


--
-- Name: COLUMN mfg_bom.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mfg_bom.status IS 'draft|active|inactive；仅 active 可被新工单/委外选入；仅 draft 可物理删除';


--
-- Name: mfg_bom_byproduct; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_bom_byproduct (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quantity numeric NOT NULL,
    note text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    bom_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL
);


--
-- Name: mfg_bom_component; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_bom_component (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quantity numeric NOT NULL,
    loss_rate numeric,
    note text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    bom_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL
);


--
-- Name: mfg_bom_route; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_bom_route (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint NOT NULL,
    requirement text,
    is_outsourced boolean DEFAULT false NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    bom_id uuid NOT NULL,
    operation_id uuid NOT NULL
);


--
-- Name: mfg_demand; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_demand (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    demand_no text NOT NULL,
    demand_date date DEFAULT CURRENT_DATE NOT NULL,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    created_by_id uuid,
    assigned_dept_id uuid,
    assign_type text NOT NULL,
    need_date date,
    CONSTRAINT mfg_demand_assign_dept_link CHECK (((assign_type = 'make'::text) = (assigned_dept_id IS NOT NULL))),
    CONSTRAINT mfg_demand_assign_type_values CHECK ((assign_type = ANY (ARRAY['purchase'::text, 'make'::text, 'stock'::text, 'close'::text])))
);


--
-- Name: COLUMN mfg_demand.assigned_dept_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mfg_demand.assigned_dept_id IS '下发车间（指派部门形态）：业务字段，须与需求单同公司；填写不受操作者部门约束，已确认后改派走 dispatch 动作';


--
-- Name: COLUMN mfg_demand.assign_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mfg_demand.assign_type IS '指派类型（purchase/make/stock/close）：纯路由声明，不占量不约束行级安排；make 时下发车间必填，其余类型必须为空';


--
-- Name: COLUMN mfg_demand.need_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mfg_demand.need_date IS '单头需求日：新增需求行的行需求日默认值，「批量带入」可刷新到全部既有行；改单头不追溯既有行';


--
-- Name: mfg_demand_arrangement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_demand_arrangement (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    demand_item_id uuid NOT NULL,
    company_id uuid NOT NULL,
    arrangement_type text NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    work_order_id uuid,
    purchase_order_item_id uuid,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    CONSTRAINT mfg_demand_arrangement_base_qty_nonnegative CHECK ((base_qty >= (0)::numeric)),
    CONSTRAINT mfg_demand_arrangement_downstream_shape CHECK ((((arrangement_type = 'make'::text) AND (work_order_id IS NOT NULL) AND (purchase_order_item_id IS NULL)) OR ((arrangement_type = ANY (ARRAY['purchase'::text, 'outsource'::text])) AND (purchase_order_item_id IS NOT NULL) AND (work_order_id IS NULL)) OR ((arrangement_type = ANY (ARRAY['stock'::text, 'close'::text])) AND (work_order_id IS NULL) AND (purchase_order_item_id IS NULL)))),
    CONSTRAINT mfg_demand_arrangement_qty_positive CHECK ((qty > (0)::numeric)),
    CONSTRAINT mfg_demand_arrangement_type_check CHECK ((arrangement_type = ANY (ARRAY['make'::text, 'purchase'::text, 'outsource'::text, 'stock'::text, 'close'::text])))
);


--
-- Name: mfg_demand_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_demand_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    need_date date NOT NULL,
    fulfillment_method text,
    status text DEFAULT 'pending'::text NOT NULL,
    material_code text DEFAULT ''::text NOT NULL,
    material_name text DEFAULT ''::text NOT NULL,
    material_spec text,
    unit_name text DEFAULT ''::text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    demand_id uuid NOT NULL,
    company_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    sales_order_item_id uuid,
    ordered_qty numeric DEFAULT '0'::numeric NOT NULL,
    received_qty numeric DEFAULT '0'::numeric NOT NULL,
    arranged_qty numeric DEFAULT '0'::numeric NOT NULL,
    completed_qty numeric DEFAULT '0'::numeric NOT NULL,
    source_work_order_id uuid,
    CONSTRAINT arranged_qty_nonnegative CHECK ((arranged_qty >= (0)::numeric)),
    CONSTRAINT completed_qty_nonnegative CHECK ((completed_qty >= (0)::numeric)),
    CONSTRAINT mfg_demand_item_source_exclusive CHECK ((NOT ((sales_order_item_id IS NOT NULL) AND (source_work_order_id IS NOT NULL)))),
    CONSTRAINT ordered_qty_nonnegative CHECK ((ordered_qty >= (0)::numeric)),
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric)),
    CONSTRAINT received_qty_nonnegative CHECK ((received_qty >= (0)::numeric))
);


--
-- Name: COLUMN mfg_demand_item.source_work_order_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mfg_demand_item.source_work_order_id IS '来源生产工单（工单物料需求派生写入）：与销售来源互斥，派生行不参与销售占用';


--
-- Name: mfg_mold_design; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_mold_design (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mold_type text NOT NULL,
    material_id uuid NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    CONSTRAINT mfg_mold_design_type_check CHECK ((mold_type = ANY (ARRAY['STAMPING'::text, 'FORMING'::text, 'POSITIONING'::text, 'OTHER'::text])))
);


--
-- Name: mfg_operation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_operation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    note text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: mfg_output; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_output (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    output_no text NOT NULL,
    output_date date DEFAULT CURRENT_DATE NOT NULL,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid,
    created_by_id uuid,
    audited_by_id uuid
);


--
-- Name: mfg_output_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_output_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    material_code text DEFAULT ''::text NOT NULL,
    material_name text DEFAULT ''::text NOT NULL,
    material_spec text,
    unit_name text DEFAULT ''::text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    output_id uuid NOT NULL,
    company_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric))
);


--
-- Name: mfg_process_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_process_template (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    note text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: mfg_process_template_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_process_template_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint NOT NULL,
    requirement text,
    is_outsourced boolean DEFAULT false NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    template_id uuid NOT NULL,
    operation_id uuid NOT NULL
);


--
-- Name: mfg_setting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_setting (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    output_overreceive_ratio numeric DEFAULT '0'::numeric NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    mold_category_id uuid,
    CONSTRAINT output_overreceive_ratio_range CHECK (((output_overreceive_ratio >= (0)::numeric) AND (output_overreceive_ratio <= (1)::numeric)))
);


--
-- Name: mfg_work_order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_work_order (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    work_order_no text NOT NULL,
    qty numeric DEFAULT '0'::numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    received_base_qty numeric DEFAULT '0'::numeric NOT NULL,
    need_date date,
    material_code text DEFAULT ''::text NOT NULL,
    material_name text DEFAULT ''::text NOT NULL,
    material_spec text,
    unit_name text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'in_progress'::text NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    demand_id uuid NOT NULL,
    demand_item_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    created_by_id uuid,
    bom_id uuid,
    owner_dept_id uuid
);


--
-- Name: COLUMN mfg_work_order.owner_dept_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mfg_work_order.owner_dept_id IS '归属部门（盖章形态）：创建时按创建人部门自动写入，不可手填；人调部门不追溯存量行';


--
-- Name: mfg_work_order_byproduct; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_work_order_byproduct (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    work_order_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    quantity numeric NOT NULL,
    note text,
    idx bigint DEFAULT 0 NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    CONSTRAINT mfg_wo_byproduct_qty_positive CHECK ((quantity > (0)::numeric))
);


--
-- Name: mfg_work_order_component; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_work_order_component (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    work_order_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    quantity numeric NOT NULL,
    loss_rate numeric,
    note text,
    idx bigint DEFAULT 0 NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    CONSTRAINT mfg_wo_component_qty_positive CHECK ((quantity > (0)::numeric))
);


--
-- Name: mfg_work_order_route; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfg_work_order_route (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    work_order_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    seq bigint NOT NULL,
    requirement text,
    is_outsourced boolean DEFAULT false NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: pur_order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_order (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_no text NOT NULL,
    order_date date DEFAULT CURRENT_DATE NOT NULL,
    order_type text DEFAULT 'regular'::text NOT NULL,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    exchange_rate numeric DEFAULT '1'::numeric NOT NULL,
    terms text,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    currency_id uuid NOT NULL,
    created_by_id uuid,
    audited_by_id uuid,
    is_outsourced boolean DEFAULT false NOT NULL,
    CONSTRAINT exchange_rate_positive CHECK ((exchange_rate > (0)::numeric)),
    CONSTRAINT party_pair CHECK (((party_type IS NULL) = (party_id IS NULL)))
);


--
-- Name: pur_order_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_order_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    received_qty numeric DEFAULT '0'::numeric NOT NULL,
    price numeric NOT NULL,
    amount numeric DEFAULT '0'::numeric NOT NULL,
    base_price numeric DEFAULT '0'::numeric NOT NULL,
    base_amount numeric DEFAULT '0'::numeric NOT NULL,
    tax_rate numeric DEFAULT 0.13 NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    customer_part_no text,
    unit_name text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    order_id uuid NOT NULL,
    company_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    quotation_item_id uuid,
    bom_id uuid,
    demand_line_id uuid,
    demand_date date,
    CONSTRAINT price_nonnegative CHECK ((price >= (0)::numeric)),
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric)),
    CONSTRAINT received_qty_nonnegative CHECK ((received_qty >= (0)::numeric)),
    CONSTRAINT tax_rate_range CHECK (((tax_rate >= (0)::numeric) AND (tax_rate < (1)::numeric)))
);


--
-- Name: pur_order_item_byproduct; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_order_item_byproduct (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quantity numeric NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    order_item_id uuid NOT NULL,
    company_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    CONSTRAINT quantity_positive CHECK ((quantity > (0)::numeric))
);


--
-- Name: pur_order_item_material; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_order_item_material (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quantity numeric NOT NULL,
    issued_qty numeric DEFAULT '0'::numeric NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    order_item_id uuid NOT NULL,
    company_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    CONSTRAINT issued_qty_nonnegative CHECK ((issued_qty >= (0)::numeric)),
    CONSTRAINT quantity_positive CHECK ((quantity > (0)::numeric))
);


--
-- Name: pur_outsourced_issue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_outsourced_issue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    issue_no text NOT NULL,
    issue_date date DEFAULT CURRENT_DATE NOT NULL,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    from_warehouse_id uuid,
    outsourced_warehouse_id uuid,
    created_by_id uuid,
    audited_by_id uuid
);


--
-- Name: pur_outsourced_issue_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_outsourced_issue_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    unit_name text NOT NULL,
    order_no text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    issue_id uuid NOT NULL,
    company_id uuid NOT NULL,
    order_item_material_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    from_warehouse_id uuid NOT NULL,
    outsourced_warehouse_id uuid NOT NULL,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric))
);


--
-- Name: pur_outsourced_receipt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_outsourced_receipt (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    receipt_no text NOT NULL,
    receipt_date date DEFAULT CURRENT_DATE NOT NULL,
    posting_date date,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid,
    outsourced_warehouse_id uuid,
    debit_account_id uuid NOT NULL,
    credit_account_id uuid NOT NULL,
    created_by_id uuid,
    audited_by_id uuid,
    CONSTRAINT party_pair CHECK (((party_type IS NULL) = (party_id IS NULL)))
);


--
-- Name: pur_outsourced_receipt_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_outsourced_receipt_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    customer_part_no text,
    unit_name text NOT NULL,
    order_no text NOT NULL,
    order_qty numeric DEFAULT '0'::numeric NOT NULL,
    order_base_qty numeric DEFAULT '0'::numeric NOT NULL,
    order_unit_name text NOT NULL,
    order_price numeric DEFAULT '0'::numeric NOT NULL,
    order_amount numeric DEFAULT '0'::numeric NOT NULL,
    order_base_price numeric DEFAULT '0'::numeric NOT NULL,
    order_base_amount numeric DEFAULT '0'::numeric NOT NULL,
    order_tax_rate numeric DEFAULT '0'::numeric NOT NULL,
    order_currency_code text NOT NULL,
    reconciled_qty numeric DEFAULT '0'::numeric NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    receipt_id uuid NOT NULL,
    company_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric)),
    CONSTRAINT reconciled_qty_nonnegative CHECK ((reconciled_qty >= (0)::numeric))
);


--
-- Name: pur_outsourced_receipt_item_byproduct; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_outsourced_receipt_item_byproduct (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    unit_name text NOT NULL,
    order_no text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    receipt_item_id uuid NOT NULL,
    company_id uuid NOT NULL,
    order_item_byproduct_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    warehouse_id uuid,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric))
);


--
-- Name: pur_outsourced_receipt_item_material; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_outsourced_receipt_item_material (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    unit_name text NOT NULL,
    order_no text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    receipt_item_id uuid NOT NULL,
    company_id uuid NOT NULL,
    order_item_material_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    outsourced_warehouse_id uuid,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric))
);


--
-- Name: pur_quotation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_quotation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quotation_no text NOT NULL,
    quotation_date date DEFAULT CURRENT_DATE NOT NULL,
    valid_until date NOT NULL,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    terms text,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    currency_id uuid NOT NULL,
    created_by_id uuid,
    audited_by_id uuid,
    CONSTRAINT party_pair CHECK (((party_type IS NULL) = (party_id IS NULL)))
);


--
-- Name: pur_quotation_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_quotation_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    pricing_mode text DEFAULT 'fixed'::text NOT NULL,
    price numeric,
    tax_rate numeric DEFAULT 0.13 NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    customer_part_no text,
    unit_name text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    quotation_id uuid NOT NULL,
    company_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    CONSTRAINT price_nonnegative CHECK (((price IS NULL) OR (price >= (0)::numeric))),
    CONSTRAINT pricing_price_consistency CHECK ((((pricing_mode = 'fixed'::text) AND (price IS NOT NULL)) OR ((pricing_mode <> 'fixed'::text) AND (price IS NULL)))),
    CONSTRAINT tax_rate_range CHECK (((tax_rate >= (0)::numeric) AND (tax_rate < (1)::numeric)))
);


--
-- Name: pur_quotation_tier; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_quotation_tier (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    min_qty numeric NOT NULL,
    price numeric NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    item_id uuid NOT NULL,
    company_id uuid NOT NULL,
    CONSTRAINT min_qty_positive CHECK ((min_qty > (0)::numeric)),
    CONSTRAINT price_nonnegative CHECK ((price >= (0)::numeric))
);


--
-- Name: pur_receipt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_receipt (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    receipt_no text NOT NULL,
    receipt_date date DEFAULT CURRENT_DATE NOT NULL,
    posting_date date,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid,
    debit_account_id uuid NOT NULL,
    credit_account_id uuid NOT NULL,
    created_by_id uuid,
    audited_by_id uuid,
    CONSTRAINT party_pair CHECK (((party_type IS NULL) = (party_id IS NULL)))
);


--
-- Name: pur_receipt_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_receipt_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    customer_part_no text,
    unit_name text NOT NULL,
    order_no text NOT NULL,
    order_qty numeric DEFAULT '0'::numeric NOT NULL,
    order_base_qty numeric DEFAULT '0'::numeric NOT NULL,
    order_unit_name text NOT NULL,
    order_price numeric DEFAULT '0'::numeric NOT NULL,
    order_amount numeric DEFAULT '0'::numeric NOT NULL,
    order_base_price numeric DEFAULT '0'::numeric NOT NULL,
    order_base_amount numeric DEFAULT '0'::numeric NOT NULL,
    order_tax_rate numeric DEFAULT '0'::numeric NOT NULL,
    order_currency_code text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    receipt_id uuid NOT NULL,
    company_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    warehouse_id uuid,
    reconciled_qty numeric DEFAULT '0'::numeric NOT NULL,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric)),
    CONSTRAINT reconciled_qty_nonnegative CHECK ((reconciled_qty >= (0)::numeric))
);


--
-- Name: pur_reconciliation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_reconciliation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reconciliation_no text NOT NULL,
    reconciliation_type text NOT NULL,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    posting_date date,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    debit_account_id uuid NOT NULL,
    credit_account_id uuid NOT NULL,
    created_by_id uuid,
    CONSTRAINT party_pair CHECK (((party_type IS NULL) = (party_id IS NULL)))
);


--
-- Name: pur_reconciliation_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_reconciliation_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    amount numeric DEFAULT '0'::numeric NOT NULL,
    base_amount numeric DEFAULT '0'::numeric NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    reconciliation_id uuid NOT NULL,
    company_id uuid NOT NULL,
    receipt_item_id uuid,
    outsourced_receipt_item_id uuid,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric)),
    CONSTRAINT receipt_item_exactly_one CHECK ((num_nonnulls(receipt_item_id, outsourced_receipt_item_id) = 1))
);


--
-- Name: pur_supplier; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pur_supplier (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    short_name text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: sal_company_account_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_company_account_default (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    delivery_debit_account_id uuid,
    delivery_credit_account_id uuid,
    receipt_debit_account_id uuid,
    receipt_credit_account_id uuid
);


--
-- Name: sal_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    short_name text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: sal_delivery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_delivery (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    delivery_no text NOT NULL,
    delivery_date date DEFAULT CURRENT_DATE NOT NULL,
    posting_date date,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid,
    debit_account_id uuid NOT NULL,
    credit_account_id uuid NOT NULL,
    created_by_id uuid,
    audited_by_id uuid,
    CONSTRAINT party_pair CHECK (((party_type IS NULL) = (party_id IS NULL)))
);


--
-- Name: sal_delivery_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_delivery_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    customer_part_no text,
    unit_name text NOT NULL,
    order_no text NOT NULL,
    order_qty numeric DEFAULT '0'::numeric NOT NULL,
    order_base_qty numeric DEFAULT '0'::numeric NOT NULL,
    order_unit_name text NOT NULL,
    order_price numeric DEFAULT '0'::numeric NOT NULL,
    order_amount numeric DEFAULT '0'::numeric NOT NULL,
    order_base_price numeric DEFAULT '0'::numeric NOT NULL,
    order_base_amount numeric DEFAULT '0'::numeric NOT NULL,
    order_tax_rate numeric DEFAULT '0'::numeric NOT NULL,
    order_currency_code text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    delivery_id uuid NOT NULL,
    company_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    warehouse_id uuid,
    reconciled_qty numeric DEFAULT '0'::numeric NOT NULL,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric)),
    CONSTRAINT reconciled_qty_nonnegative CHECK ((reconciled_qty >= (0)::numeric))
);


--
-- Name: sal_delivery_pack_box; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_delivery_pack_box (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    box_no bigint NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    delivery_id uuid NOT NULL,
    company_id uuid NOT NULL
);


--
-- Name: sal_delivery_pack_line; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_delivery_pack_line (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    customer_part_no text,
    unit_name text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    delivery_id uuid NOT NULL,
    company_id uuid NOT NULL,
    pack_box_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric))
);


--
-- Name: sal_order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_order (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_no text NOT NULL,
    order_date date DEFAULT CURRENT_DATE NOT NULL,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    terms text,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    created_by_id uuid,
    audited_by_id uuid,
    exchange_rate numeric DEFAULT '1'::numeric NOT NULL,
    currency_id uuid NOT NULL,
    order_type text DEFAULT 'regular'::text NOT NULL,
    CONSTRAINT exchange_rate_positive CHECK ((exchange_rate > (0)::numeric)),
    CONSTRAINT party_pair CHECK (((party_type IS NULL) = (party_id IS NULL)))
);


--
-- Name: sal_order_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_order_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    price numeric NOT NULL,
    amount numeric DEFAULT '0'::numeric NOT NULL,
    tax_rate numeric DEFAULT 0.13 NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    order_id uuid NOT NULL,
    company_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    customer_part_no text,
    unit_name text NOT NULL,
    base_price numeric DEFAULT '0'::numeric NOT NULL,
    base_amount numeric DEFAULT '0'::numeric NOT NULL,
    quotation_item_id uuid,
    shipped_qty numeric DEFAULT '0'::numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    CONSTRAINT price_nonnegative CHECK ((price >= (0)::numeric)),
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric)),
    CONSTRAINT shipped_qty_nonnegative CHECK ((shipped_qty >= (0)::numeric)),
    CONSTRAINT tax_rate_range CHECK (((tax_rate >= (0)::numeric) AND (tax_rate < (1)::numeric)))
);


--
-- Name: sal_quotation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_quotation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quotation_no text NOT NULL,
    quotation_date date DEFAULT CURRENT_DATE NOT NULL,
    valid_until date NOT NULL,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    terms text,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    currency_id uuid NOT NULL,
    created_by_id uuid,
    audited_by_id uuid,
    CONSTRAINT party_pair CHECK (((party_type IS NULL) = (party_id IS NULL)))
);


--
-- Name: sal_quotation_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_quotation_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    pricing_mode text DEFAULT 'fixed'::text NOT NULL,
    price numeric,
    tax_rate numeric DEFAULT 0.13 NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    customer_part_no text,
    unit_name text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    quotation_id uuid NOT NULL,
    company_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    CONSTRAINT price_nonnegative CHECK (((price IS NULL) OR (price >= (0)::numeric))),
    CONSTRAINT pricing_price_consistency CHECK ((((pricing_mode = 'fixed'::text) AND (price IS NOT NULL)) OR ((pricing_mode <> 'fixed'::text) AND (price IS NULL)))),
    CONSTRAINT tax_rate_range CHECK (((tax_rate >= (0)::numeric) AND (tax_rate < (1)::numeric)))
);


--
-- Name: sal_quotation_tier; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_quotation_tier (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    min_qty numeric NOT NULL,
    price numeric NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    item_id uuid NOT NULL,
    company_id uuid NOT NULL,
    CONSTRAINT min_qty_positive CHECK ((min_qty > (0)::numeric)),
    CONSTRAINT price_nonnegative CHECK ((price >= (0)::numeric))
);


--
-- Name: sal_reconciliation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_reconciliation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reconciliation_no text NOT NULL,
    reconciliation_type text NOT NULL,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    posting_date date,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    debit_account_id uuid NOT NULL,
    credit_account_id uuid NOT NULL,
    created_by_id uuid,
    CONSTRAINT party_pair CHECK (((party_type IS NULL) = (party_id IS NULL)))
);


--
-- Name: sal_reconciliation_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_reconciliation_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    amount numeric DEFAULT '0'::numeric NOT NULL,
    base_amount numeric DEFAULT '0'::numeric NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    reconciliation_id uuid NOT NULL,
    company_id uuid NOT NULL,
    delivery_item_id uuid NOT NULL,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric))
);


--
-- Name: sal_setting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sal_setting (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sample_item_max_qty bigint DEFAULT 100 NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    delivery_overship_ratio numeric DEFAULT '0'::numeric NOT NULL,
    spot_item_max_qty bigint DEFAULT 100 NOT NULL,
    receipt_overreceive_ratio numeric DEFAULT '0'::numeric NOT NULL,
    demand_overorder_ratio numeric DEFAULT '0'::numeric NOT NULL,
    CONSTRAINT delivery_overship_ratio_range CHECK (((delivery_overship_ratio >= (0)::numeric) AND (delivery_overship_ratio <= (1)::numeric))),
    CONSTRAINT demand_overorder_ratio_range CHECK (((demand_overorder_ratio >= (0)::numeric) AND (demand_overorder_ratio <= (1)::numeric))),
    CONSTRAINT receipt_overreceive_ratio_range CHECK (((receipt_overreceive_ratio >= (0)::numeric) AND (receipt_overreceive_ratio <= (1)::numeric))),
    CONSTRAINT sample_item_max_qty_positive CHECK ((sample_item_max_qty > 0)),
    CONSTRAINT spot_item_max_qty_positive CHECK ((spot_item_max_qty > 0))
);


--
-- Name: scm_order_flow_item; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.scm_order_flow_item AS
 SELECT ('purchase_receipt:'::text || (i.id)::text) AS id,
    'purchase_receipt'::text AS flow_type,
    h.receipt_no AS voucher_no,
    h.receipt_date AS voucher_date,
    h.status,
    i.company_id,
    oi.order_id,
    i.order_item_id,
    i.material_code,
    i.material_name,
    i.material_spec,
    i.customer_part_no,
    i.unit_name,
    i.qty
   FROM ((public.pur_receipt_item i
     JOIN public.pur_receipt h ON ((h.id = i.receipt_id)))
     JOIN public.pur_order_item oi ON ((oi.id = i.order_item_id)))
UNION ALL
 SELECT ('outsourced_receipt:'::text || (i.id)::text) AS id,
    'outsourced_receipt'::text AS flow_type,
    h.receipt_no AS voucher_no,
    h.receipt_date AS voucher_date,
    h.status,
    i.company_id,
    oi.order_id,
    i.order_item_id,
    i.material_code,
    i.material_name,
    i.material_spec,
    i.customer_part_no,
    i.unit_name,
    i.qty
   FROM ((public.pur_outsourced_receipt_item i
     JOIN public.pur_outsourced_receipt h ON ((h.id = i.receipt_id)))
     JOIN public.pur_order_item oi ON ((oi.id = i.order_item_id)))
UNION ALL
 SELECT ('outsourced_issue:'::text || (i.id)::text) AS id,
    'outsourced_issue'::text AS flow_type,
    h.issue_no AS voucher_no,
    h.issue_date AS voucher_date,
    h.status,
    i.company_id,
    oi.order_id,
    oim.order_item_id,
    i.material_code,
    i.material_name,
    i.material_spec,
    NULL::text AS customer_part_no,
    i.unit_name,
    i.qty
   FROM (((public.pur_outsourced_issue_item i
     JOIN public.pur_outsourced_issue h ON ((h.id = i.issue_id)))
     JOIN public.pur_order_item_material oim ON ((oim.id = i.order_item_material_id)))
     JOIN public.pur_order_item oi ON ((oi.id = oim.order_item_id)))
UNION ALL
 SELECT ('sales_delivery:'::text || (i.id)::text) AS id,
    'sales_delivery'::text AS flow_type,
    h.delivery_no AS voucher_no,
    h.delivery_date AS voucher_date,
    h.status,
    i.company_id,
    oi.order_id,
    i.order_item_id,
    i.material_code,
    i.material_name,
    i.material_spec,
    i.customer_part_no,
    i.unit_name,
    i.qty
   FROM ((public.sal_delivery_item i
     JOIN public.sal_delivery h ON ((h.id = i.delivery_id)))
     JOIN public.sal_order_item oi ON ((oi.id = i.order_item_id)));


--
-- Name: sys_attachment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_attachment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_type text NOT NULL,
    owner_id uuid NOT NULL,
    category text DEFAULT 'default'::text NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    file_id uuid NOT NULL,
    company_id uuid
);


--
-- Name: sys_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource text NOT NULL,
    record_id uuid NOT NULL,
    record_label text,
    action_type text NOT NULL,
    action_name text NOT NULL,
    actor_id uuid,
    actor_name text,
    company_id uuid,
    changes jsonb NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: sys_department; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_department (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    parent_id uuid,
    code text NOT NULL,
    name text NOT NULL,
    path text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: TABLE sys_department; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sys_department IS '部门：挂公司的组织树主数据（IAM 维护）；path 为物化路径，子树查询走前缀匹配';


--
-- Name: COLUMN sys_department.path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sys_department.path IS '物化路径：/{祖先id}/…/{本id}/；移动节点重算整棵子树';


--
-- Name: sys_file; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_file (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    storage text NOT NULL,
    key text NOT NULL,
    filename text NOT NULL,
    content_type text,
    size bigint,
    sha256 text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    uploaded_by_id uuid
);


--
-- Name: sys_numbering_counter; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_numbering_counter (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope_key text NOT NULL,
    value bigint DEFAULT 0 NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    rule_id uuid NOT NULL
);


--
-- Name: sys_numbering_rule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_numbering_rule (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource text NOT NULL,
    name text NOT NULL,
    segments jsonb[] NOT NULL,
    per_company boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: sys_print_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_print_template (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    resource text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    file_id uuid NOT NULL
);


--
-- Name: sys_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_role (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    builtin boolean DEFAULT false NOT NULL,
    grants_all boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN sys_role.grants_all; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sys_role.grants_all IS '全域授权旗标：持有即覆盖全部权限码（all 范围）；内置 admin 用此旗标取代 * 通配行';


--
-- Name: sys_role_menu; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_role_menu (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_id uuid NOT NULL,
    menu_code text NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: TABLE sys_role_menu; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sys_role_menu IS '角色菜单白名单：每行=该角色可见的一个叶子菜单 code；角色无行=不限制（全可见）';


--
-- Name: sys_role_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_role_permission (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    permission text NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    role_id uuid NOT NULL,
    scope text DEFAULT 'all'::text NOT NULL,
    CONSTRAINT sys_role_permission_scope_check CHECK ((scope = ANY (ARRAY['all'::text, 'dept_tree'::text, 'dept'::text, 'self'::text])))
);


--
-- Name: COLUMN sys_role_permission.scope; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sys_role_permission.scope IS '数据范围：all/dept_tree/dept/self（granted 预留、第一期拒写）；多角色同码取格上最大';


--
-- Name: sys_setting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_setting (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    setup_completed_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    market_fetch_schedule_enabled boolean DEFAULT true NOT NULL,
    market_fetch_last_interval_minutes integer DEFAULT 60 NOT NULL,
    market_fetch_settlement_enabled boolean DEFAULT true NOT NULL,
    market_fetch_last_run_at timestamp(0) without time zone,
    market_fetch_last_summary text,
    CONSTRAINT market_fetch_last_interval_allowed CHECK ((market_fetch_last_interval_minutes = ANY (ARRAY[30, 60, 120])))
);


--
-- Name: sys_storage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_storage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    label text NOT NULL,
    kind text NOT NULL,
    root text,
    endpoint text,
    region text,
    bucket text,
    prefix text,
    access_key_id text,
    secret_access_key text,
    builtin boolean DEFAULT false NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);


--
-- Name: sys_todo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_todo (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    source_no text NOT NULL,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    amount numeric DEFAULT '0'::numeric NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    closed_reason text,
    source_changed_at timestamp without time zone NOT NULL,
    closed_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    created_by_id uuid
);


--
-- Name: sys_todo_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_todo_state (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    read_at timestamp without time zone,
    dismissed_at timestamp without time zone,
    reset_basis_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    todo_id uuid NOT NULL,
    user_id uuid NOT NULL
);


--
-- Name: sys_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_user (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username public.citext NOT NULL,
    name text,
    hashed_password text NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    super_admin boolean DEFAULT false NOT NULL,
    all_companies boolean DEFAULT false NOT NULL,
    preferred_language text,
    email text,
    auth_user_id text,
    department_id uuid
);


--
-- Name: COLUMN sys_user.department_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sys_user.department_id IS '所属部门（至多一个）；部门所在公司必须已在该用户公司授权集内（IAM 写侧硬校验）';


--
-- Name: sys_user_company; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_user_company (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    user_id uuid NOT NULL,
    company_id uuid NOT NULL
);


--
-- Name: sys_user_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sys_user_role (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL
);


--
-- Name: acc_gl_entry seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_entry ALTER COLUMN seq SET DEFAULT nextval('public.acc_gl_entry_seq_seq'::regclass);


--
-- Name: inv_stock_entry seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_entry ALTER COLUMN seq SET DEFAULT nextval('public.inv_stock_entry_seq_seq'::regclass);


--
-- Name: acc_bank_account acc_bank_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_account
    ADD CONSTRAINT acc_bank_account_pkey PRIMARY KEY (id);


--
-- Name: acc_bank_import_item acc_bank_import_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import_item
    ADD CONSTRAINT acc_bank_import_item_pkey PRIMARY KEY (id);


--
-- Name: acc_bank_import acc_bank_import_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import
    ADD CONSTRAINT acc_bank_import_pkey PRIMARY KEY (id);


--
-- Name: acc_bank_import_template acc_bank_import_template_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import_template
    ADD CONSTRAINT acc_bank_import_template_pkey PRIMARY KEY (id);


--
-- Name: acc_bank_reconciliation acc_bank_reconciliation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_reconciliation
    ADD CONSTRAINT acc_bank_reconciliation_pkey PRIMARY KEY (id);


--
-- Name: acc_bank_transaction acc_bank_transaction_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_transaction
    ADD CONSTRAINT acc_bank_transaction_pkey PRIMARY KEY (id);


--
-- Name: acc_bill_holding acc_bill_holding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_holding
    ADD CONSTRAINT acc_bill_holding_pkey PRIMARY KEY (id);


--
-- Name: acc_bill acc_bill_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill
    ADD CONSTRAINT acc_bill_pkey PRIMARY KEY (id);


--
-- Name: acc_bill_transaction acc_bill_transaction_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_transaction
    ADD CONSTRAINT acc_bill_transaction_pkey PRIMARY KEY (id);


--
-- Name: acc_expense_report_item acc_expense_report_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_expense_report_item
    ADD CONSTRAINT acc_expense_report_item_pkey PRIMARY KEY (id);


--
-- Name: acc_expense_report acc_expense_report_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_expense_report
    ADD CONSTRAINT acc_expense_report_pkey PRIMARY KEY (id);


--
-- Name: acc_gl_entry acc_gl_entry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_entry
    ADD CONSTRAINT acc_gl_entry_pkey PRIMARY KEY (id);


--
-- Name: acc_gl_journal_line acc_gl_journal_line_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_journal_line
    ADD CONSTRAINT acc_gl_journal_line_pkey PRIMARY KEY (id);


--
-- Name: acc_gl_journal acc_gl_journal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_journal
    ADD CONSTRAINT acc_gl_journal_pkey PRIMARY KEY (id);


--
-- Name: acc_setting acc_setting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_setting
    ADD CONSTRAINT acc_setting_pkey PRIMARY KEY (id);


--
-- Name: acc_vat_invoice acc_vat_invoice_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_vat_invoice
    ADD CONSTRAINT acc_vat_invoice_pkey PRIMARY KEY (id);


--
-- Name: auth_account auth_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT auth_account_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);


--
-- Name: auth_user auth_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);


--
-- Name: auth_verification auth_verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_verification
    ADD CONSTRAINT auth_verification_pkey PRIMARY KEY (id);


--
-- Name: bas_account bas_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_account
    ADD CONSTRAINT bas_account_pkey PRIMARY KEY (id);


--
-- Name: bas_market_instrument bas_market_instrument_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_market_instrument
    ADD CONSTRAINT bas_market_instrument_pkey PRIMARY KEY (id);


--
-- Name: bas_market_price_point bas_market_price_point_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_market_price_point
    ADD CONSTRAINT bas_market_price_point_pkey PRIMARY KEY (id);


--
-- Name: bas_party_address bas_party_address_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_party_address
    ADD CONSTRAINT bas_party_address_pkey PRIMARY KEY (id);


--
-- Name: hr_attendance_correction hr_attendance_correction_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance_correction
    ADD CONSTRAINT hr_attendance_correction_pkey PRIMARY KEY (id);


--
-- Name: hr_attendance_day hr_attendance_day_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance_day
    ADD CONSTRAINT hr_attendance_day_pkey PRIMARY KEY (id);


--
-- Name: hr_attendance_import hr_attendance_import_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance_import
    ADD CONSTRAINT hr_attendance_import_pkey PRIMARY KEY (id);


--
-- Name: hr_attendance_punch hr_attendance_punch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance_punch
    ADD CONSTRAINT hr_attendance_punch_pkey PRIMARY KEY (id);


--
-- Name: hr_employee_loan hr_employee_loan_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee_loan
    ADD CONSTRAINT hr_employee_loan_pkey PRIMARY KEY (id);


--
-- Name: hr_employees hr_employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_pkey PRIMARY KEY (id);


--
-- Name: hr_payroll_payment hr_payroll_payment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payroll_payment
    ADD CONSTRAINT hr_payroll_payment_pkey PRIMARY KEY (id);


--
-- Name: hr_payroll hr_payroll_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payroll
    ADD CONSTRAINT hr_payroll_pkey PRIMARY KEY (id);


--
-- Name: inv_material_category inv_material_category_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_material_category
    ADD CONSTRAINT inv_material_category_pkey PRIMARY KEY (id);


--
-- Name: inv_material inv_material_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_material
    ADD CONSTRAINT inv_material_pkey PRIMARY KEY (id);


--
-- Name: inv_material_unit inv_material_unit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_material_unit
    ADD CONSTRAINT inv_material_unit_pkey PRIMARY KEY (id);


--
-- Name: inv_stock_count_item inv_stock_count_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_count_item
    ADD CONSTRAINT inv_stock_count_item_pkey PRIMARY KEY (id);


--
-- Name: inv_stock_count inv_stock_count_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_count
    ADD CONSTRAINT inv_stock_count_pkey PRIMARY KEY (id);


--
-- Name: inv_stock_doc_item inv_stock_doc_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_doc_item
    ADD CONSTRAINT inv_stock_doc_item_pkey PRIMARY KEY (id);


--
-- Name: inv_stock_doc inv_stock_doc_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_doc
    ADD CONSTRAINT inv_stock_doc_pkey PRIMARY KEY (id);


--
-- Name: inv_stock_entry inv_stock_entry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_entry
    ADD CONSTRAINT inv_stock_entry_pkey PRIMARY KEY (id);


--
-- Name: inv_stock_transfer_item inv_stock_transfer_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer_item
    ADD CONSTRAINT inv_stock_transfer_item_pkey PRIMARY KEY (id);


--
-- Name: inv_stock_transfer inv_stock_transfer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer
    ADD CONSTRAINT inv_stock_transfer_pkey PRIMARY KEY (id);


--
-- Name: inv_warehouse inv_warehouse_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_warehouse
    ADD CONSTRAINT inv_warehouse_pkey PRIMARY KEY (id);


--
-- Name: mfg_bom_byproduct mfg_bom_byproduct_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom_byproduct
    ADD CONSTRAINT mfg_bom_byproduct_pkey PRIMARY KEY (id);


--
-- Name: mfg_bom_component mfg_bom_component_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom_component
    ADD CONSTRAINT mfg_bom_component_pkey PRIMARY KEY (id);


--
-- Name: mfg_bom mfg_bom_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom
    ADD CONSTRAINT mfg_bom_pkey PRIMARY KEY (id);


--
-- Name: mfg_bom_route mfg_bom_route_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom_route
    ADD CONSTRAINT mfg_bom_route_pkey PRIMARY KEY (id);


--
-- Name: mfg_demand_arrangement mfg_demand_arrangement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand_arrangement
    ADD CONSTRAINT mfg_demand_arrangement_pkey PRIMARY KEY (id);


--
-- Name: mfg_demand_item mfg_demand_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand_item
    ADD CONSTRAINT mfg_demand_item_pkey PRIMARY KEY (id);


--
-- Name: mfg_demand mfg_demand_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand
    ADD CONSTRAINT mfg_demand_pkey PRIMARY KEY (id);


--
-- Name: mfg_mold_design mfg_mold_design_material_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_mold_design
    ADD CONSTRAINT mfg_mold_design_material_unique UNIQUE (material_id);


--
-- Name: mfg_mold_design mfg_mold_design_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_mold_design
    ADD CONSTRAINT mfg_mold_design_pkey PRIMARY KEY (id);


--
-- Name: mfg_operation mfg_operation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_operation
    ADD CONSTRAINT mfg_operation_pkey PRIMARY KEY (id);


--
-- Name: mfg_output_item mfg_output_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_output_item
    ADD CONSTRAINT mfg_output_item_pkey PRIMARY KEY (id);


--
-- Name: mfg_output mfg_output_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_output
    ADD CONSTRAINT mfg_output_pkey PRIMARY KEY (id);


--
-- Name: mfg_process_template_item mfg_process_template_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_process_template_item
    ADD CONSTRAINT mfg_process_template_item_pkey PRIMARY KEY (id);


--
-- Name: mfg_process_template mfg_process_template_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_process_template
    ADD CONSTRAINT mfg_process_template_pkey PRIMARY KEY (id);


--
-- Name: mfg_setting mfg_setting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_setting
    ADD CONSTRAINT mfg_setting_pkey PRIMARY KEY (id);


--
-- Name: mfg_work_order_byproduct mfg_work_order_byproduct_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order_byproduct
    ADD CONSTRAINT mfg_work_order_byproduct_pkey PRIMARY KEY (id);


--
-- Name: mfg_work_order_component mfg_work_order_component_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order_component
    ADD CONSTRAINT mfg_work_order_component_pkey PRIMARY KEY (id);


--
-- Name: mfg_work_order mfg_work_order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order
    ADD CONSTRAINT mfg_work_order_pkey PRIMARY KEY (id);


--
-- Name: mfg_work_order_route mfg_work_order_route_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order_route
    ADD CONSTRAINT mfg_work_order_route_pkey PRIMARY KEY (id);


--
-- Name: pur_order_item_byproduct pur_order_item_byproduct_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item_byproduct
    ADD CONSTRAINT pur_order_item_byproduct_pkey PRIMARY KEY (id);


--
-- Name: pur_order_item_material pur_order_item_material_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item_material
    ADD CONSTRAINT pur_order_item_material_pkey PRIMARY KEY (id);


--
-- Name: pur_order_item pur_order_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item
    ADD CONSTRAINT pur_order_item_pkey PRIMARY KEY (id);


--
-- Name: pur_order pur_order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order
    ADD CONSTRAINT pur_order_pkey PRIMARY KEY (id);


--
-- Name: pur_outsourced_issue_item pur_outsourced_issue_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue_item
    ADD CONSTRAINT pur_outsourced_issue_item_pkey PRIMARY KEY (id);


--
-- Name: pur_outsourced_issue pur_outsourced_issue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue
    ADD CONSTRAINT pur_outsourced_issue_pkey PRIMARY KEY (id);


--
-- Name: pur_outsourced_receipt_item_byproduct pur_outsourced_receipt_item_byproduct_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_byproduct
    ADD CONSTRAINT pur_outsourced_receipt_item_byproduct_pkey PRIMARY KEY (id);


--
-- Name: pur_outsourced_receipt_item_material pur_outsourced_receipt_item_material_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_material
    ADD CONSTRAINT pur_outsourced_receipt_item_material_pkey PRIMARY KEY (id);


--
-- Name: pur_outsourced_receipt_item pur_outsourced_receipt_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item
    ADD CONSTRAINT pur_outsourced_receipt_item_pkey PRIMARY KEY (id);


--
-- Name: pur_outsourced_receipt pur_outsourced_receipt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt
    ADD CONSTRAINT pur_outsourced_receipt_pkey PRIMARY KEY (id);


--
-- Name: pur_quotation_item pur_quotation_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation_item
    ADD CONSTRAINT pur_quotation_item_pkey PRIMARY KEY (id);


--
-- Name: pur_quotation pur_quotation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation
    ADD CONSTRAINT pur_quotation_pkey PRIMARY KEY (id);


--
-- Name: pur_quotation_tier pur_quotation_tier_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation_tier
    ADD CONSTRAINT pur_quotation_tier_pkey PRIMARY KEY (id);


--
-- Name: pur_receipt_item pur_receipt_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt_item
    ADD CONSTRAINT pur_receipt_item_pkey PRIMARY KEY (id);


--
-- Name: pur_receipt pur_receipt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt
    ADD CONSTRAINT pur_receipt_pkey PRIMARY KEY (id);


--
-- Name: pur_reconciliation_item pur_reconciliation_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_reconciliation_item
    ADD CONSTRAINT pur_reconciliation_item_pkey PRIMARY KEY (id);


--
-- Name: pur_reconciliation pur_reconciliation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_reconciliation
    ADD CONSTRAINT pur_reconciliation_pkey PRIMARY KEY (id);


--
-- Name: pur_supplier pur_supplier_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_supplier
    ADD CONSTRAINT pur_supplier_pkey PRIMARY KEY (id);


--
-- Name: sal_company_account_default sal_company_account_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_company_account_default
    ADD CONSTRAINT sal_company_account_default_pkey PRIMARY KEY (id);


--
-- Name: sal_customers sal_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_customers
    ADD CONSTRAINT sal_customers_pkey PRIMARY KEY (id);


--
-- Name: sal_delivery_item sal_delivery_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_item
    ADD CONSTRAINT sal_delivery_item_pkey PRIMARY KEY (id);


--
-- Name: sal_delivery_pack_box sal_delivery_pack_box_delivery_box_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_pack_box
    ADD CONSTRAINT sal_delivery_pack_box_delivery_box_no_key UNIQUE (delivery_id, box_no);


--
-- Name: sal_delivery_pack_box sal_delivery_pack_box_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_pack_box
    ADD CONSTRAINT sal_delivery_pack_box_pkey PRIMARY KEY (id);


--
-- Name: sal_delivery_pack_line sal_delivery_pack_line_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_pkey PRIMARY KEY (id);


--
-- Name: sal_delivery sal_delivery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery
    ADD CONSTRAINT sal_delivery_pkey PRIMARY KEY (id);


--
-- Name: sal_order_item sal_order_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_order_item
    ADD CONSTRAINT sal_order_item_pkey PRIMARY KEY (id);


--
-- Name: sal_order sal_order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_order
    ADD CONSTRAINT sal_order_pkey PRIMARY KEY (id);


--
-- Name: sal_quotation_item sal_quotation_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation_item
    ADD CONSTRAINT sal_quotation_item_pkey PRIMARY KEY (id);


--
-- Name: sal_quotation sal_quotation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation
    ADD CONSTRAINT sal_quotation_pkey PRIMARY KEY (id);


--
-- Name: sal_quotation_tier sal_quotation_tier_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation_tier
    ADD CONSTRAINT sal_quotation_tier_pkey PRIMARY KEY (id);


--
-- Name: sal_reconciliation_item sal_reconciliation_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_reconciliation_item
    ADD CONSTRAINT sal_reconciliation_item_pkey PRIMARY KEY (id);


--
-- Name: sal_reconciliation sal_reconciliation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_reconciliation
    ADD CONSTRAINT sal_reconciliation_pkey PRIMARY KEY (id);


--
-- Name: sal_setting sal_setting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_setting
    ADD CONSTRAINT sal_setting_pkey PRIMARY KEY (id);


--
-- Name: sys_attachment sys_attachment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_attachment
    ADD CONSTRAINT sys_attachment_pkey PRIMARY KEY (id);


--
-- Name: sys_audit_log sys_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_audit_log
    ADD CONSTRAINT sys_audit_log_pkey PRIMARY KEY (id);


--
-- Name: bas_company sys_company_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_company
    ADD CONSTRAINT sys_company_pkey PRIMARY KEY (id);


--
-- Name: bas_currency sys_currency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_currency
    ADD CONSTRAINT sys_currency_pkey PRIMARY KEY (id);


--
-- Name: sys_department sys_department_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_department
    ADD CONSTRAINT sys_department_pkey PRIMARY KEY (id);


--
-- Name: sys_file sys_file_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_file
    ADD CONSTRAINT sys_file_pkey PRIMARY KEY (id);


--
-- Name: sys_numbering_counter sys_numbering_counter_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_numbering_counter
    ADD CONSTRAINT sys_numbering_counter_pkey PRIMARY KEY (id);


--
-- Name: sys_numbering_rule sys_numbering_rule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_numbering_rule
    ADD CONSTRAINT sys_numbering_rule_pkey PRIMARY KEY (id);


--
-- Name: sys_print_template sys_print_template_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_print_template
    ADD CONSTRAINT sys_print_template_pkey PRIMARY KEY (id);


--
-- Name: sys_role_menu sys_role_menu_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_role_menu
    ADD CONSTRAINT sys_role_menu_pkey PRIMARY KEY (id);


--
-- Name: sys_role_permission sys_role_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_role_permission
    ADD CONSTRAINT sys_role_permission_pkey PRIMARY KEY (id);


--
-- Name: sys_role sys_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_role
    ADD CONSTRAINT sys_role_pkey PRIMARY KEY (id);


--
-- Name: sys_setting sys_setting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_setting
    ADD CONSTRAINT sys_setting_pkey PRIMARY KEY (id);


--
-- Name: sys_storage sys_storage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_storage
    ADD CONSTRAINT sys_storage_pkey PRIMARY KEY (id);


--
-- Name: sys_todo sys_todo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_todo
    ADD CONSTRAINT sys_todo_pkey PRIMARY KEY (id);


--
-- Name: sys_todo_state sys_todo_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_todo_state
    ADD CONSTRAINT sys_todo_state_pkey PRIMARY KEY (id);


--
-- Name: bas_unit sys_unit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_unit
    ADD CONSTRAINT sys_unit_pkey PRIMARY KEY (id);


--
-- Name: sys_user_company sys_user_company_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_user_company
    ADD CONSTRAINT sys_user_company_pkey PRIMARY KEY (id);


--
-- Name: sys_user sys_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_user
    ADD CONSTRAINT sys_user_pkey PRIMARY KEY (id);


--
-- Name: sys_user_role sys_user_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_user_role
    ADD CONSTRAINT sys_user_role_pkey PRIMARY KEY (id);


--
-- Name: sys_user sys_user_unique_auth_user_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_user
    ADD CONSTRAINT sys_user_unique_auth_user_id UNIQUE (auth_user_id);


--
-- Name: acc_bank_account_unique_account_no_per_company_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX acc_bank_account_unique_account_no_per_company_index ON public.acc_bank_account USING btree (company_id, account_no);


--
-- Name: acc_bank_account_unique_alias_per_company_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX acc_bank_account_unique_alias_per_company_index ON public.acc_bank_account USING btree (company_id, alias);


--
-- Name: acc_bank_import_company_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_bank_import_company_id_index ON public.acc_bank_import USING btree (company_id);


--
-- Name: acc_bank_import_item_import_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_bank_import_item_import_id_index ON public.acc_bank_import_item USING btree (import_id);


--
-- Name: acc_bank_import_template_unique_name_per_company_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX acc_bank_import_template_unique_name_per_company_index ON public.acc_bank_import_template USING btree (company_id, name);


--
-- Name: acc_bank_reconciliation_journal_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_bank_reconciliation_journal_id_index ON public.acc_bank_reconciliation USING btree (journal_id);


--
-- Name: acc_bank_reconciliation_unique_txn_journal_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX acc_bank_reconciliation_unique_txn_journal_index ON public.acc_bank_reconciliation USING btree (bank_transaction_id, journal_id);


--
-- Name: acc_bank_transaction_company_id_bank_account_id_occurred_at_ind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_bank_transaction_company_id_bank_account_id_occurred_at_ind ON public.acc_bank_transaction USING btree (company_id, bank_account_id, occurred_at);


--
-- Name: acc_bill_due_date_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_bill_due_date_index ON public.acc_bill USING btree (due_date);


--
-- Name: acc_bill_holding_bill_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_bill_holding_bill_id_index ON public.acc_bill_holding USING btree (bill_id);


--
-- Name: acc_bill_holding_company_id_bank_account_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_bill_holding_company_id_bank_account_id_index ON public.acc_bill_holding USING btree (company_id, bank_account_id);


--
-- Name: acc_bill_holding_company_id_due_date_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_bill_holding_company_id_due_date_index ON public.acc_bill_holding USING btree (company_id, due_date);


--
-- Name: acc_bill_transaction_bill_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_bill_transaction_bill_id_status_index ON public.acc_bill_transaction USING btree (bill_id, status);


--
-- Name: acc_bill_transaction_company_id_bank_account_id_occurred_on_ind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_bill_transaction_company_id_bank_account_id_occurred_on_ind ON public.acc_bill_transaction USING btree (company_id, bank_account_id, occurred_on);


--
-- Name: acc_bill_transaction_company_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_bill_transaction_company_id_status_index ON public.acc_bill_transaction USING btree (company_id, status);


--
-- Name: acc_bill_transaction_doc_no_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX acc_bill_transaction_doc_no_uniq ON public.acc_bill_transaction USING btree (company_id, doc_no) WHERE (doc_no IS NOT NULL);


--
-- Name: acc_bill_unique_bill_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX acc_bill_unique_bill_no_index ON public.acc_bill USING btree (bill_no);


--
-- Name: acc_expense_report_company_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_expense_report_company_id_status_index ON public.acc_expense_report USING btree (company_id, status);


--
-- Name: acc_expense_report_unique_doc_no_per_company_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX acc_expense_report_unique_doc_no_per_company_index ON public.acc_expense_report USING btree (company_id, doc_no);


--
-- Name: acc_gl_entry_company_id_account_id_posting_date_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_gl_entry_company_id_account_id_posting_date_index ON public.acc_gl_entry USING btree (company_id, account_id, posting_date);


--
-- Name: acc_gl_entry_voucher_type_voucher_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_gl_entry_voucher_type_voucher_id_index ON public.acc_gl_entry USING btree (voucher_type, voucher_id);


--
-- Name: acc_gl_journal_unique_voucher_no_per_company_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX acc_gl_journal_unique_voucher_no_per_company_index ON public.acc_gl_journal USING btree (company_id, voucher_no);


--
-- Name: acc_vat_invoice_company_id_invoice_date_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_vat_invoice_company_id_invoice_date_index ON public.acc_vat_invoice USING btree (company_id, invoice_date);


--
-- Name: acc_vat_invoice_company_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acc_vat_invoice_company_id_status_index ON public.acc_vat_invoice USING btree (company_id, status);


--
-- Name: acc_vat_invoice_doc_no_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX acc_vat_invoice_doc_no_uniq ON public.acc_vat_invoice USING btree (company_id, doc_no) WHERE (doc_no IS NOT NULL);


--
-- Name: acc_vat_invoice_no_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX acc_vat_invoice_no_uniq ON public.acc_vat_invoice USING btree (company_id, invoice_code, invoice_no) WHERE (invoice_no IS NOT NULL);


--
-- Name: auth_account_provider_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_account_provider_account_idx ON public.auth_account USING btree (provider_id, account_id);


--
-- Name: auth_account_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_account_user_id_idx ON public.auth_account USING btree (user_id);


--
-- Name: auth_session_unique_token_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_session_unique_token_index ON public.auth_session USING btree (token);


--
-- Name: auth_session_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_session_user_id_idx ON public.auth_session USING btree (user_id);


--
-- Name: auth_user_unique_email_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_user_unique_email_index ON public.auth_user USING btree (email);


--
-- Name: auth_user_unique_username_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_user_unique_username_index ON public.auth_user USING btree (username);


--
-- Name: auth_verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_verification_identifier_idx ON public.auth_verification USING btree (identifier);


--
-- Name: bas_account_unique_code_per_company_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bas_account_unique_code_per_company_index ON public.bas_account USING btree (company_id, code);


--
-- Name: bas_company_unique_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bas_company_unique_code_index ON public.bas_company USING btree (code);


--
-- Name: bas_currency_unique_iso_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bas_currency_unique_iso_code_index ON public.bas_currency USING btree (iso_code);


--
-- Name: bas_market_instrument_unique_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bas_market_instrument_unique_code_index ON public.bas_market_instrument USING btree (code);


--
-- Name: bas_market_price_point_unique_active_point_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bas_market_price_point_unique_active_point_index ON public.bas_market_price_point USING btree (instrument_id, observed_at, price_kind) WHERE (is_voided = false);


--
-- Name: bas_party_address_default_per_purpose_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bas_party_address_default_per_purpose_uidx ON public.bas_party_address USING btree (party_type, party_id, purpose) WHERE (is_default = true);


--
-- Name: bas_party_address_party_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bas_party_address_party_idx ON public.bas_party_address USING btree (party_type, party_id);


--
-- Name: bas_unit_unique_base_per_type_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bas_unit_unique_base_per_type_index ON public.bas_unit USING btree (unit_type) WHERE (is_base = true);


--
-- Name: bas_unit_unique_symbol_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bas_unit_unique_symbol_index ON public.bas_unit USING btree (symbol);


--
-- Name: hr_attendance_correction_date_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_attendance_correction_date_index ON public.hr_attendance_correction USING btree (date);


--
-- Name: hr_attendance_correction_unique_employee_date_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX hr_attendance_correction_unique_employee_date_index ON public.hr_attendance_correction USING btree (employee_id, date);


--
-- Name: hr_attendance_day_date_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_attendance_day_date_index ON public.hr_attendance_day USING btree (date);


--
-- Name: hr_attendance_day_unique_employee_date_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX hr_attendance_day_unique_employee_date_index ON public.hr_attendance_day USING btree (employee_id, date);


--
-- Name: hr_attendance_punch_import_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_attendance_punch_import_id_index ON public.hr_attendance_punch USING btree (import_id);


--
-- Name: hr_attendance_punch_punched_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_attendance_punch_punched_at_index ON public.hr_attendance_punch USING btree (punched_at);


--
-- Name: hr_attendance_punch_unique_employee_punch_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX hr_attendance_punch_unique_employee_punch_index ON public.hr_attendance_punch USING btree (employee_id, punched_at);


--
-- Name: hr_employee_loan_employee_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_employee_loan_employee_id_index ON public.hr_employee_loan USING btree (employee_id);


--
-- Name: hr_employee_loan_payroll_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_employee_loan_payroll_id_index ON public.hr_employee_loan USING btree (payroll_id) WHERE (payroll_id IS NOT NULL);


--
-- Name: hr_employees_unique_attendance_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX hr_employees_unique_attendance_no_index ON public.hr_employees USING btree (attendance_no);


--
-- Name: hr_employees_unique_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX hr_employees_unique_code_index ON public.hr_employees USING btree (code);


--
-- Name: hr_employees_unique_id_number_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX hr_employees_unique_id_number_index ON public.hr_employees USING btree (id_number);


--
-- Name: hr_payroll_month_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_payroll_month_index ON public.hr_payroll USING btree (month);


--
-- Name: hr_payroll_payment_employee_id_month_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_payroll_payment_employee_id_month_index ON public.hr_payroll_payment USING btree (employee_id, month);


--
-- Name: hr_payroll_payment_month_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_payroll_payment_month_index ON public.hr_payroll_payment USING btree (month);


--
-- Name: hr_payroll_payment_payroll_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_payroll_payment_payroll_id_index ON public.hr_payroll_payment USING btree (payroll_id);


--
-- Name: hr_payroll_unique_employee_month_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX hr_payroll_unique_employee_month_index ON public.hr_payroll USING btree (employee_id, month);


--
-- Name: inv_material_category_unique_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inv_material_category_unique_code_index ON public.inv_material_category USING btree (code);


--
-- Name: inv_material_unique_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inv_material_unique_code_index ON public.inv_material USING btree (code);


--
-- Name: inv_material_unit_unique_material_unit_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inv_material_unit_unique_material_unit_index ON public.inv_material_unit USING btree (material_id, unit_id);


--
-- Name: inv_stock_count_unique_doc_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inv_stock_count_unique_doc_no_index ON public.inv_stock_count USING btree (company_id, doc_no);


--
-- Name: inv_stock_doc_unique_doc_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inv_stock_doc_unique_doc_no_index ON public.inv_stock_doc USING btree (company_id, doc_no);


--
-- Name: inv_stock_entry_company_id_warehouse_id_material_id_posting_dat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inv_stock_entry_company_id_warehouse_id_material_id_posting_dat ON public.inv_stock_entry USING btree (company_id, warehouse_id, material_id, posting_date);


--
-- Name: inv_stock_entry_voucher_type_voucher_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inv_stock_entry_voucher_type_voucher_id_index ON public.inv_stock_entry USING btree (voucher_type, voucher_id);


--
-- Name: inv_stock_transfer_unique_doc_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inv_stock_transfer_unique_doc_no_index ON public.inv_stock_transfer USING btree (company_id, doc_no);


--
-- Name: inv_warehouse_unique_code_per_company_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inv_warehouse_unique_code_per_company_index ON public.inv_warehouse USING btree (company_id, code);


--
-- Name: inv_warehouse_unique_name_per_company_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inv_warehouse_unique_name_per_company_index ON public.inv_warehouse USING btree (company_id, name);


--
-- Name: mfg_bom_unique_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mfg_bom_unique_code_index ON public.mfg_bom USING btree (code);


--
-- Name: mfg_demand_arrangement_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mfg_demand_arrangement_item_idx ON public.mfg_demand_arrangement USING btree (demand_item_id);


--
-- Name: mfg_demand_arrangement_po_item_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mfg_demand_arrangement_po_item_uidx ON public.mfg_demand_arrangement USING btree (purchase_order_item_id) WHERE (purchase_order_item_id IS NOT NULL);


--
-- Name: mfg_demand_arrangement_work_order_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mfg_demand_arrangement_work_order_uidx ON public.mfg_demand_arrangement USING btree (work_order_id) WHERE (work_order_id IS NOT NULL);


--
-- Name: mfg_demand_assigned_dept_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mfg_demand_assigned_dept_id_index ON public.mfg_demand USING btree (assigned_dept_id);


--
-- Name: mfg_demand_item_source_work_order_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mfg_demand_item_source_work_order_id_index ON public.mfg_demand_item USING btree (source_work_order_id);


--
-- Name: mfg_demand_unique_demand_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mfg_demand_unique_demand_no_index ON public.mfg_demand USING btree (company_id, demand_no);


--
-- Name: mfg_operation_unique_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mfg_operation_unique_code_index ON public.mfg_operation USING btree (code);


--
-- Name: mfg_output_unique_output_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mfg_output_unique_output_no_index ON public.mfg_output USING btree (company_id, output_no);


--
-- Name: mfg_process_template_unique_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mfg_process_template_unique_code_index ON public.mfg_process_template USING btree (code);


--
-- Name: mfg_wo_byproduct_wo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mfg_wo_byproduct_wo_idx ON public.mfg_work_order_byproduct USING btree (work_order_id);


--
-- Name: mfg_wo_component_wo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mfg_wo_component_wo_idx ON public.mfg_work_order_component USING btree (work_order_id);


--
-- Name: mfg_wo_route_wo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mfg_wo_route_wo_idx ON public.mfg_work_order_route USING btree (work_order_id);


--
-- Name: mfg_work_order_demand_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mfg_work_order_demand_item_idx ON public.mfg_work_order USING btree (demand_item_id) WHERE (status <> 'voided'::text);


--
-- Name: mfg_work_order_owner_dept_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mfg_work_order_owner_dept_id_index ON public.mfg_work_order USING btree (owner_dept_id);


--
-- Name: mfg_work_order_unique_work_order_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mfg_work_order_unique_work_order_no_index ON public.mfg_work_order USING btree (company_id, work_order_no);


--
-- Name: pur_order_item_demand_line_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pur_order_item_demand_line_id_index ON public.pur_order_item USING btree (demand_line_id);


--
-- Name: pur_order_unique_order_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pur_order_unique_order_no_index ON public.pur_order USING btree (company_id, order_no);


--
-- Name: pur_outsourced_issue_unique_issue_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pur_outsourced_issue_unique_issue_no_index ON public.pur_outsourced_issue USING btree (company_id, issue_no);


--
-- Name: pur_outsourced_receipt_unique_receipt_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pur_outsourced_receipt_unique_receipt_no_index ON public.pur_outsourced_receipt USING btree (company_id, receipt_no);


--
-- Name: pur_quotation_item_unique_material_unit_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pur_quotation_item_unique_material_unit_index ON public.pur_quotation_item USING btree (quotation_id, material_id, unit_id);


--
-- Name: pur_quotation_tier_unique_item_min_qty_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pur_quotation_tier_unique_item_min_qty_index ON public.pur_quotation_tier USING btree (item_id, min_qty);


--
-- Name: pur_quotation_unique_quotation_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pur_quotation_unique_quotation_no_index ON public.pur_quotation USING btree (company_id, quotation_no);


--
-- Name: pur_receipt_unique_receipt_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pur_receipt_unique_receipt_no_index ON public.pur_receipt USING btree (company_id, receipt_no);


--
-- Name: pur_reconciliation_unique_reconciliation_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pur_reconciliation_unique_reconciliation_no_index ON public.pur_reconciliation USING btree (company_id, reconciliation_no);


--
-- Name: pur_supplier_unique_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pur_supplier_unique_code_index ON public.pur_supplier USING btree (code);


--
-- Name: sal_company_account_default_unique_company_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sal_company_account_default_unique_company_index ON public.sal_company_account_default USING btree (company_id);


--
-- Name: sal_customers_unique_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sal_customers_unique_code_index ON public.sal_customers USING btree (code);


--
-- Name: sal_delivery_unique_delivery_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sal_delivery_unique_delivery_no_index ON public.sal_delivery USING btree (company_id, delivery_no);


--
-- Name: sal_order_unique_order_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sal_order_unique_order_no_index ON public.sal_order USING btree (company_id, order_no);


--
-- Name: sal_quotation_item_unique_material_unit_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sal_quotation_item_unique_material_unit_index ON public.sal_quotation_item USING btree (quotation_id, material_id, unit_id);


--
-- Name: sal_quotation_tier_unique_item_min_qty_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sal_quotation_tier_unique_item_min_qty_index ON public.sal_quotation_tier USING btree (item_id, min_qty);


--
-- Name: sal_quotation_unique_quotation_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sal_quotation_unique_quotation_no_index ON public.sal_quotation USING btree (company_id, quotation_no);


--
-- Name: sal_reconciliation_unique_reconciliation_no_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sal_reconciliation_unique_reconciliation_no_index ON public.sal_reconciliation USING btree (company_id, reconciliation_no);


--
-- Name: sys_attachment_company_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sys_attachment_company_id_index ON public.sys_attachment USING btree (company_id);


--
-- Name: sys_attachment_owner_type_owner_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sys_attachment_owner_type_owner_id_index ON public.sys_attachment USING btree (owner_type, owner_id);


--
-- Name: sys_audit_log_inserted_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sys_audit_log_inserted_at_index ON public.sys_audit_log USING btree (inserted_at);


--
-- Name: sys_audit_log_resource_record_id_inserted_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sys_audit_log_resource_record_id_inserted_at_index ON public.sys_audit_log USING btree (resource, record_id, inserted_at);


--
-- Name: sys_department_company_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_department_company_code_index ON public.sys_department USING btree (company_id, code);


--
-- Name: sys_department_parent_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sys_department_parent_id_index ON public.sys_department USING btree (parent_id);


--
-- Name: sys_department_path_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sys_department_path_index ON public.sys_department USING btree (path text_pattern_ops);


--
-- Name: sys_numbering_counter_unique_scope_per_rule_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_numbering_counter_unique_scope_per_rule_index ON public.sys_numbering_counter USING btree (rule_id, scope_key);


--
-- Name: sys_numbering_rule_one_enabled_per_resource_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_numbering_rule_one_enabled_per_resource_index ON public.sys_numbering_rule USING btree (resource) WHERE enabled;


--
-- Name: sys_print_template_one_default_per_resource_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_print_template_one_default_per_resource_index ON public.sys_print_template USING btree (is_default, resource) WHERE is_default;


--
-- Name: sys_role_menu_unique_role_menu_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_role_menu_unique_role_menu_index ON public.sys_role_menu USING btree (role_id, menu_code);


--
-- Name: sys_role_permission_unique_role_permission_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_role_permission_unique_role_permission_index ON public.sys_role_permission USING btree (role_id, permission);


--
-- Name: sys_role_unique_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_role_unique_code_index ON public.sys_role USING btree (code);


--
-- Name: sys_storage_single_default_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_storage_single_default_index ON public.sys_storage USING btree (is_default) WHERE is_default;


--
-- Name: sys_storage_unique_name_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_storage_unique_name_index ON public.sys_storage USING btree (name);


--
-- Name: sys_todo_company_status_inserted_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sys_todo_company_status_inserted_at_index ON public.sys_todo USING btree (company_id, status, inserted_at);


--
-- Name: sys_todo_one_active_per_source_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_todo_one_active_per_source_index ON public.sys_todo USING btree (source_type, source_id) WHERE (status = 'active'::text);


--
-- Name: sys_todo_source_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sys_todo_source_index ON public.sys_todo USING btree (source_type, source_id);


--
-- Name: sys_todo_state_todo_id_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_todo_state_todo_id_user_id_index ON public.sys_todo_state USING btree (todo_id, user_id);


--
-- Name: sys_todo_state_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sys_todo_state_user_id_index ON public.sys_todo_state USING btree (user_id);


--
-- Name: sys_user_company_unique_user_company_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_user_company_unique_user_company_index ON public.sys_user_company USING btree (user_id, company_id);


--
-- Name: sys_user_department_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sys_user_department_id_index ON public.sys_user USING btree (department_id);


--
-- Name: sys_user_role_unique_user_role_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_user_role_unique_user_role_index ON public.sys_user_role USING btree (user_id, role_id);


--
-- Name: sys_user_unique_email_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_user_unique_email_index ON public.sys_user USING btree (lower(email)) WHERE (email IS NOT NULL);


--
-- Name: sys_user_unique_username_index; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sys_user_unique_username_index ON public.sys_user USING btree (username);


--
-- Name: acc_bank_account acc_bank_account_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_account
    ADD CONSTRAINT acc_bank_account_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.bas_account(id);


--
-- Name: acc_bank_account acc_bank_account_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_account
    ADD CONSTRAINT acc_bank_account_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_bank_account acc_bank_account_currency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_account
    ADD CONSTRAINT acc_bank_account_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES public.bas_currency(id);


--
-- Name: acc_bank_import acc_bank_import_bank_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import
    ADD CONSTRAINT acc_bank_import_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.acc_bank_account(id);


--
-- Name: acc_bank_import acc_bank_import_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import
    ADD CONSTRAINT acc_bank_import_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_bank_import acc_bank_import_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import
    ADD CONSTRAINT acc_bank_import_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: acc_bank_import acc_bank_import_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import
    ADD CONSTRAINT acc_bank_import_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.sys_file(id);


--
-- Name: acc_bank_import acc_bank_import_imported_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import
    ADD CONSTRAINT acc_bank_import_imported_by_id_fkey FOREIGN KEY (imported_by_id) REFERENCES public.sys_user(id);


--
-- Name: acc_bank_import_item acc_bank_import_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import_item
    ADD CONSTRAINT acc_bank_import_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_bank_import_item acc_bank_import_item_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import_item
    ADD CONSTRAINT acc_bank_import_item_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.acc_bank_import(id) ON DELETE CASCADE;


--
-- Name: acc_bank_import_item acc_bank_import_item_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import_item
    ADD CONSTRAINT acc_bank_import_item_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.acc_bank_transaction(id);


--
-- Name: acc_bank_import_template acc_bank_import_template_bank_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import_template
    ADD CONSTRAINT acc_bank_import_template_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.acc_bank_account(id);


--
-- Name: acc_bank_import_template acc_bank_import_template_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import_template
    ADD CONSTRAINT acc_bank_import_template_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_bank_import acc_bank_import_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_import
    ADD CONSTRAINT acc_bank_import_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.acc_bank_import_template(id);


--
-- Name: acc_bank_reconciliation acc_bank_reconciliation_bank_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_reconciliation
    ADD CONSTRAINT acc_bank_reconciliation_bank_transaction_id_fkey FOREIGN KEY (bank_transaction_id) REFERENCES public.acc_bank_transaction(id) ON DELETE RESTRICT;


--
-- Name: acc_bank_reconciliation acc_bank_reconciliation_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_reconciliation
    ADD CONSTRAINT acc_bank_reconciliation_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_bank_reconciliation acc_bank_reconciliation_journal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_reconciliation
    ADD CONSTRAINT acc_bank_reconciliation_journal_id_fkey FOREIGN KEY (journal_id) REFERENCES public.acc_gl_journal(id) ON DELETE RESTRICT;


--
-- Name: acc_bank_transaction acc_bank_transaction_bank_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_transaction
    ADD CONSTRAINT acc_bank_transaction_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.acc_bank_account(id);


--
-- Name: acc_bank_transaction acc_bank_transaction_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bank_transaction
    ADD CONSTRAINT acc_bank_transaction_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_bill_holding acc_bill_holding_bank_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_holding
    ADD CONSTRAINT acc_bill_holding_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.acc_bank_account(id);


--
-- Name: acc_bill_holding acc_bill_holding_bill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_holding
    ADD CONSTRAINT acc_bill_holding_bill_id_fkey FOREIGN KEY (bill_id) REFERENCES public.acc_bill(id);


--
-- Name: acc_bill_holding acc_bill_holding_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_holding
    ADD CONSTRAINT acc_bill_holding_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_bill_holding acc_bill_holding_source_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_holding
    ADD CONSTRAINT acc_bill_holding_source_transaction_id_fkey FOREIGN KEY (source_transaction_id) REFERENCES public.acc_bill_transaction(id);


--
-- Name: acc_bill_transaction acc_bill_transaction_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_transaction
    ADD CONSTRAINT acc_bill_transaction_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: acc_bill_transaction acc_bill_transaction_bank_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_transaction
    ADD CONSTRAINT acc_bill_transaction_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.acc_bank_account(id);


--
-- Name: acc_bill_transaction acc_bill_transaction_bill_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_transaction
    ADD CONSTRAINT acc_bill_transaction_bill_account_id_fkey FOREIGN KEY (bill_account_id) REFERENCES public.bas_account(id);


--
-- Name: acc_bill_transaction acc_bill_transaction_bill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_transaction
    ADD CONSTRAINT acc_bill_transaction_bill_id_fkey FOREIGN KEY (bill_id) REFERENCES public.acc_bill(id);


--
-- Name: acc_bill_transaction acc_bill_transaction_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_transaction
    ADD CONSTRAINT acc_bill_transaction_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_bill_transaction acc_bill_transaction_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_transaction
    ADD CONSTRAINT acc_bill_transaction_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: acc_bill_transaction acc_bill_transaction_interest_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_transaction
    ADD CONSTRAINT acc_bill_transaction_interest_account_id_fkey FOREIGN KEY (interest_account_id) REFERENCES public.bas_account(id);


--
-- Name: acc_bill_transaction acc_bill_transaction_settle_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_transaction
    ADD CONSTRAINT acc_bill_transaction_settle_account_id_fkey FOREIGN KEY (settle_account_id) REFERENCES public.bas_account(id);


--
-- Name: acc_bill_transaction acc_bill_transaction_to_bank_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_bill_transaction
    ADD CONSTRAINT acc_bill_transaction_to_bank_account_id_fkey FOREIGN KEY (to_bank_account_id) REFERENCES public.acc_bank_account(id);


--
-- Name: acc_expense_report acc_expense_report_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_expense_report
    ADD CONSTRAINT acc_expense_report_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: acc_expense_report acc_expense_report_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_expense_report
    ADD CONSTRAINT acc_expense_report_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_expense_report acc_expense_report_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_expense_report
    ADD CONSTRAINT acc_expense_report_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: acc_expense_report acc_expense_report_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_expense_report
    ADD CONSTRAINT acc_expense_report_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: acc_expense_report_item acc_expense_report_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_expense_report_item
    ADD CONSTRAINT acc_expense_report_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_expense_report_item acc_expense_report_item_expense_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_expense_report_item
    ADD CONSTRAINT acc_expense_report_item_expense_account_id_fkey FOREIGN KEY (expense_account_id) REFERENCES public.bas_account(id);


--
-- Name: acc_expense_report_item acc_expense_report_item_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_expense_report_item
    ADD CONSTRAINT acc_expense_report_item_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.acc_vat_invoice(id);


--
-- Name: acc_expense_report_item acc_expense_report_item_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_expense_report_item
    ADD CONSTRAINT acc_expense_report_item_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.acc_expense_report(id) ON DELETE CASCADE;


--
-- Name: acc_expense_report acc_expense_report_payment_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_expense_report
    ADD CONSTRAINT acc_expense_report_payment_account_id_fkey FOREIGN KEY (payment_account_id) REFERENCES public.bas_account(id);


--
-- Name: acc_gl_entry acc_gl_entry_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_entry
    ADD CONSTRAINT acc_gl_entry_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.bas_account(id);


--
-- Name: acc_gl_entry acc_gl_entry_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_entry
    ADD CONSTRAINT acc_gl_entry_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_gl_entry acc_gl_entry_currency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_entry
    ADD CONSTRAINT acc_gl_entry_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES public.bas_currency(id);


--
-- Name: acc_gl_journal acc_gl_journal_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_journal
    ADD CONSTRAINT acc_gl_journal_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_gl_journal acc_gl_journal_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_journal
    ADD CONSTRAINT acc_gl_journal_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: acc_gl_journal_line acc_gl_journal_line_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_journal_line
    ADD CONSTRAINT acc_gl_journal_line_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.bas_account(id);


--
-- Name: acc_gl_journal_line acc_gl_journal_line_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_journal_line
    ADD CONSTRAINT acc_gl_journal_line_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_gl_journal_line acc_gl_journal_line_currency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_journal_line
    ADD CONSTRAINT acc_gl_journal_line_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES public.bas_currency(id);


--
-- Name: acc_gl_journal_line acc_gl_journal_line_journal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_journal_line
    ADD CONSTRAINT acc_gl_journal_line_journal_id_fkey FOREIGN KEY (journal_id) REFERENCES public.acc_gl_journal(id) ON DELETE CASCADE;


--
-- Name: acc_gl_journal acc_gl_journal_submitted_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_gl_journal
    ADD CONSTRAINT acc_gl_journal_submitted_by_id_fkey FOREIGN KEY (submitted_by_id) REFERENCES public.sys_user(id);


--
-- Name: acc_vat_invoice acc_vat_invoice_amount_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_vat_invoice
    ADD CONSTRAINT acc_vat_invoice_amount_account_id_fkey FOREIGN KEY (amount_account_id) REFERENCES public.bas_account(id);


--
-- Name: acc_vat_invoice acc_vat_invoice_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_vat_invoice
    ADD CONSTRAINT acc_vat_invoice_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: acc_vat_invoice acc_vat_invoice_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_vat_invoice
    ADD CONSTRAINT acc_vat_invoice_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: acc_vat_invoice acc_vat_invoice_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_vat_invoice
    ADD CONSTRAINT acc_vat_invoice_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: acc_vat_invoice acc_vat_invoice_mirror_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_vat_invoice
    ADD CONSTRAINT acc_vat_invoice_mirror_invoice_id_fkey FOREIGN KEY (mirror_invoice_id) REFERENCES public.acc_vat_invoice(id) ON DELETE SET NULL;


--
-- Name: acc_vat_invoice acc_vat_invoice_party_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_vat_invoice
    ADD CONSTRAINT acc_vat_invoice_party_account_id_fkey FOREIGN KEY (party_account_id) REFERENCES public.bas_account(id);


--
-- Name: acc_vat_invoice acc_vat_invoice_pur_reconciliation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_vat_invoice
    ADD CONSTRAINT acc_vat_invoice_pur_reconciliation_id_fkey FOREIGN KEY (pur_reconciliation_id) REFERENCES public.pur_reconciliation(id);


--
-- Name: acc_vat_invoice acc_vat_invoice_sal_reconciliation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_vat_invoice
    ADD CONSTRAINT acc_vat_invoice_sal_reconciliation_id_fkey FOREIGN KEY (sal_reconciliation_id) REFERENCES public.sal_reconciliation(id);


--
-- Name: acc_vat_invoice acc_vat_invoice_tax_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acc_vat_invoice
    ADD CONSTRAINT acc_vat_invoice_tax_account_id_fkey FOREIGN KEY (tax_account_id) REFERENCES public.bas_account(id);


--
-- Name: auth_account auth_account_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT auth_account_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: auth_session auth_session_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: bas_account bas_account_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_account
    ADD CONSTRAINT bas_account_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: bas_account bas_account_currency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_account
    ADD CONSTRAINT bas_account_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES public.bas_currency(id);


--
-- Name: bas_account bas_account_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_account
    ADD CONSTRAINT bas_account_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.bas_account(id);


--
-- Name: bas_company bas_company_base_currency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_company
    ADD CONSTRAINT bas_company_base_currency_id_fkey FOREIGN KEY (base_currency_id) REFERENCES public.bas_currency(id);


--
-- Name: bas_company bas_company_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_company
    ADD CONSTRAINT bas_company_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.bas_company(id);


--
-- Name: bas_market_instrument bas_market_instrument_currency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_market_instrument
    ADD CONSTRAINT bas_market_instrument_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES public.bas_currency(id);


--
-- Name: bas_market_instrument bas_market_instrument_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_market_instrument
    ADD CONSTRAINT bas_market_instrument_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: bas_market_price_point bas_market_price_point_currency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_market_price_point
    ADD CONSTRAINT bas_market_price_point_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES public.bas_currency(id);


--
-- Name: bas_market_price_point bas_market_price_point_instrument_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_market_price_point
    ADD CONSTRAINT bas_market_price_point_instrument_id_fkey FOREIGN KEY (instrument_id) REFERENCES public.bas_market_instrument(id);


--
-- Name: bas_market_price_point bas_market_price_point_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bas_market_price_point
    ADD CONSTRAINT bas_market_price_point_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: hr_attendance_correction hr_attendance_correction_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance_correction
    ADD CONSTRAINT hr_attendance_correction_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: hr_attendance_correction hr_attendance_correction_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance_correction
    ADD CONSTRAINT hr_attendance_correction_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_attendance_day hr_attendance_day_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance_day
    ADD CONSTRAINT hr_attendance_day_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_attendance_import hr_attendance_import_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance_import
    ADD CONSTRAINT hr_attendance_import_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: hr_attendance_import hr_attendance_import_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance_import
    ADD CONSTRAINT hr_attendance_import_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.sys_file(id);


--
-- Name: hr_attendance_import hr_attendance_import_imported_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance_import
    ADD CONSTRAINT hr_attendance_import_imported_by_id_fkey FOREIGN KEY (imported_by_id) REFERENCES public.sys_user(id);


--
-- Name: hr_attendance_punch hr_attendance_punch_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance_punch
    ADD CONSTRAINT hr_attendance_punch_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_attendance_punch hr_attendance_punch_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_attendance_punch
    ADD CONSTRAINT hr_attendance_punch_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.hr_attendance_import(id) ON DELETE CASCADE;


--
-- Name: hr_employee_loan hr_employee_loan_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee_loan
    ADD CONSTRAINT hr_employee_loan_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: hr_employee_loan hr_employee_loan_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee_loan
    ADD CONSTRAINT hr_employee_loan_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_employee_loan hr_employee_loan_payroll_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employee_loan
    ADD CONSTRAINT hr_employee_loan_payroll_id_fkey FOREIGN KEY (payroll_id) REFERENCES public.hr_payroll(id);


--
-- Name: hr_payroll hr_payroll_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payroll
    ADD CONSTRAINT hr_payroll_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_payroll_payment hr_payroll_payment_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payroll_payment
    ADD CONSTRAINT hr_payroll_payment_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: hr_payroll_payment hr_payroll_payment_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payroll_payment
    ADD CONSTRAINT hr_payroll_payment_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_payroll_payment hr_payroll_payment_payroll_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_payroll_payment
    ADD CONSTRAINT hr_payroll_payment_payroll_id_fkey FOREIGN KEY (payroll_id) REFERENCES public.hr_payroll(id);


--
-- Name: inv_material inv_material_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_material
    ADD CONSTRAINT inv_material_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.inv_material_category(id);


--
-- Name: inv_material_category inv_material_category_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_material_category
    ADD CONSTRAINT inv_material_category_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.inv_material_category(id);


--
-- Name: inv_material inv_material_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_material
    ADD CONSTRAINT inv_material_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.sal_customers(id);


--
-- Name: inv_material inv_material_default_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_material
    ADD CONSTRAINT inv_material_default_unit_id_fkey FOREIGN KEY (default_unit_id) REFERENCES public.bas_unit(id);


--
-- Name: inv_material_unit inv_material_unit_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_material_unit
    ADD CONSTRAINT inv_material_unit_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id) ON DELETE CASCADE;


--
-- Name: inv_material_unit inv_material_unit_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_material_unit
    ADD CONSTRAINT inv_material_unit_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: inv_stock_count inv_stock_count_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_count
    ADD CONSTRAINT inv_stock_count_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: inv_stock_count inv_stock_count_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_count
    ADD CONSTRAINT inv_stock_count_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: inv_stock_count inv_stock_count_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_count
    ADD CONSTRAINT inv_stock_count_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: inv_stock_count_item inv_stock_count_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_count_item
    ADD CONSTRAINT inv_stock_count_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: inv_stock_count_item inv_stock_count_item_count_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_count_item
    ADD CONSTRAINT inv_stock_count_item_count_id_fkey FOREIGN KEY (count_id) REFERENCES public.inv_stock_count(id) ON DELETE CASCADE;


--
-- Name: inv_stock_count_item inv_stock_count_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_count_item
    ADD CONSTRAINT inv_stock_count_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: inv_stock_count_item inv_stock_count_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_count_item
    ADD CONSTRAINT inv_stock_count_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: inv_stock_count inv_stock_count_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_count
    ADD CONSTRAINT inv_stock_count_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: inv_stock_doc inv_stock_doc_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_doc
    ADD CONSTRAINT inv_stock_doc_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: inv_stock_doc inv_stock_doc_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_doc
    ADD CONSTRAINT inv_stock_doc_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: inv_stock_doc inv_stock_doc_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_doc
    ADD CONSTRAINT inv_stock_doc_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: inv_stock_doc_item inv_stock_doc_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_doc_item
    ADD CONSTRAINT inv_stock_doc_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: inv_stock_doc_item inv_stock_doc_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_doc_item
    ADD CONSTRAINT inv_stock_doc_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: inv_stock_doc_item inv_stock_doc_item_stock_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_doc_item
    ADD CONSTRAINT inv_stock_doc_item_stock_doc_id_fkey FOREIGN KEY (stock_doc_id) REFERENCES public.inv_stock_doc(id) ON DELETE CASCADE;


--
-- Name: inv_stock_doc_item inv_stock_doc_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_doc_item
    ADD CONSTRAINT inv_stock_doc_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: inv_stock_doc inv_stock_doc_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_doc
    ADD CONSTRAINT inv_stock_doc_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: inv_stock_entry inv_stock_entry_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_entry
    ADD CONSTRAINT inv_stock_entry_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: inv_stock_entry inv_stock_entry_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_entry
    ADD CONSTRAINT inv_stock_entry_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: inv_stock_entry inv_stock_entry_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_entry
    ADD CONSTRAINT inv_stock_entry_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: inv_stock_transfer inv_stock_transfer_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer
    ADD CONSTRAINT inv_stock_transfer_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: inv_stock_transfer inv_stock_transfer_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer
    ADD CONSTRAINT inv_stock_transfer_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: inv_stock_transfer inv_stock_transfer_from_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer
    ADD CONSTRAINT inv_stock_transfer_from_warehouse_id_fkey FOREIGN KEY (from_warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: inv_stock_transfer_item inv_stock_transfer_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer_item
    ADD CONSTRAINT inv_stock_transfer_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: inv_stock_transfer_item inv_stock_transfer_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer_item
    ADD CONSTRAINT inv_stock_transfer_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: inv_stock_transfer_item inv_stock_transfer_item_stock_transfer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer_item
    ADD CONSTRAINT inv_stock_transfer_item_stock_transfer_id_fkey FOREIGN KEY (stock_transfer_id) REFERENCES public.inv_stock_transfer(id) ON DELETE CASCADE;


--
-- Name: inv_stock_transfer_item inv_stock_transfer_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer_item
    ADD CONSTRAINT inv_stock_transfer_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: inv_stock_transfer inv_stock_transfer_received_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer
    ADD CONSTRAINT inv_stock_transfer_received_by_id_fkey FOREIGN KEY (received_by_id) REFERENCES public.sys_user(id);


--
-- Name: inv_stock_transfer inv_stock_transfer_shipped_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer
    ADD CONSTRAINT inv_stock_transfer_shipped_by_id_fkey FOREIGN KEY (shipped_by_id) REFERENCES public.sys_user(id);


--
-- Name: inv_stock_transfer inv_stock_transfer_to_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer
    ADD CONSTRAINT inv_stock_transfer_to_warehouse_id_fkey FOREIGN KEY (to_warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: inv_stock_transfer inv_stock_transfer_transit_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_stock_transfer
    ADD CONSTRAINT inv_stock_transfer_transit_warehouse_id_fkey FOREIGN KEY (transit_warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: inv_warehouse inv_warehouse_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_warehouse
    ADD CONSTRAINT inv_warehouse_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.bas_account(id);


--
-- Name: inv_warehouse inv_warehouse_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_warehouse
    ADD CONSTRAINT inv_warehouse_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: inv_warehouse inv_warehouse_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_warehouse
    ADD CONSTRAINT inv_warehouse_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.inv_warehouse(id);


--
-- Name: mfg_bom_byproduct mfg_bom_byproduct_bom_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom_byproduct
    ADD CONSTRAINT mfg_bom_byproduct_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES public.mfg_bom(id) ON DELETE CASCADE;


--
-- Name: mfg_bom_byproduct mfg_bom_byproduct_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom_byproduct
    ADD CONSTRAINT mfg_bom_byproduct_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: mfg_bom_byproduct mfg_bom_byproduct_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom_byproduct
    ADD CONSTRAINT mfg_bom_byproduct_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: mfg_bom_component mfg_bom_component_bom_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom_component
    ADD CONSTRAINT mfg_bom_component_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES public.mfg_bom(id) ON DELETE CASCADE;


--
-- Name: mfg_bom_component mfg_bom_component_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom_component
    ADD CONSTRAINT mfg_bom_component_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: mfg_bom_component mfg_bom_component_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom_component
    ADD CONSTRAINT mfg_bom_component_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: mfg_bom mfg_bom_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom
    ADD CONSTRAINT mfg_bom_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id) ON DELETE RESTRICT;


--
-- Name: mfg_bom_route mfg_bom_route_bom_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom_route
    ADD CONSTRAINT mfg_bom_route_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES public.mfg_bom(id) ON DELETE CASCADE;


--
-- Name: mfg_bom_route mfg_bom_route_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_bom_route
    ADD CONSTRAINT mfg_bom_route_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.mfg_operation(id);


--
-- Name: mfg_demand_arrangement mfg_demand_arrangement_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand_arrangement
    ADD CONSTRAINT mfg_demand_arrangement_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: mfg_demand_arrangement mfg_demand_arrangement_demand_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand_arrangement
    ADD CONSTRAINT mfg_demand_arrangement_demand_item_id_fkey FOREIGN KEY (demand_item_id) REFERENCES public.mfg_demand_item(id) ON DELETE CASCADE;


--
-- Name: mfg_demand_arrangement mfg_demand_arrangement_work_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand_arrangement
    ADD CONSTRAINT mfg_demand_arrangement_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES public.mfg_work_order(id) ON DELETE CASCADE;


--
-- Name: mfg_demand mfg_demand_assigned_dept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand
    ADD CONSTRAINT mfg_demand_assigned_dept_id_fkey FOREIGN KEY (assigned_dept_id) REFERENCES public.sys_department(id);


--
-- Name: mfg_demand mfg_demand_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand
    ADD CONSTRAINT mfg_demand_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: mfg_demand mfg_demand_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand
    ADD CONSTRAINT mfg_demand_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: mfg_demand_item mfg_demand_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand_item
    ADD CONSTRAINT mfg_demand_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: mfg_demand_item mfg_demand_item_demand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand_item
    ADD CONSTRAINT mfg_demand_item_demand_id_fkey FOREIGN KEY (demand_id) REFERENCES public.mfg_demand(id) ON DELETE CASCADE;


--
-- Name: mfg_demand_item mfg_demand_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand_item
    ADD CONSTRAINT mfg_demand_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: mfg_demand_item mfg_demand_item_sales_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand_item
    ADD CONSTRAINT mfg_demand_item_sales_order_item_id_fkey FOREIGN KEY (sales_order_item_id) REFERENCES public.sal_order_item(id) ON DELETE RESTRICT;


--
-- Name: mfg_demand_item mfg_demand_item_source_work_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand_item
    ADD CONSTRAINT mfg_demand_item_source_work_order_id_fkey FOREIGN KEY (source_work_order_id) REFERENCES public.mfg_work_order(id);


--
-- Name: mfg_demand_item mfg_demand_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_demand_item
    ADD CONSTRAINT mfg_demand_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: mfg_mold_design mfg_mold_design_material_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_mold_design
    ADD CONSTRAINT mfg_mold_design_material_fk FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: mfg_output mfg_output_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_output
    ADD CONSTRAINT mfg_output_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: mfg_output mfg_output_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_output
    ADD CONSTRAINT mfg_output_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: mfg_output mfg_output_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_output
    ADD CONSTRAINT mfg_output_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: mfg_output_item mfg_output_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_output_item
    ADD CONSTRAINT mfg_output_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: mfg_output_item mfg_output_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_output_item
    ADD CONSTRAINT mfg_output_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: mfg_output_item mfg_output_item_output_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_output_item
    ADD CONSTRAINT mfg_output_item_output_id_fkey FOREIGN KEY (output_id) REFERENCES public.mfg_output(id) ON DELETE CASCADE;


--
-- Name: mfg_output_item mfg_output_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_output_item
    ADD CONSTRAINT mfg_output_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: mfg_output_item mfg_output_item_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_output_item
    ADD CONSTRAINT mfg_output_item_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: mfg_output_item mfg_output_item_work_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_output_item
    ADD CONSTRAINT mfg_output_item_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES public.mfg_work_order(id) ON DELETE RESTRICT;


--
-- Name: mfg_output mfg_output_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_output
    ADD CONSTRAINT mfg_output_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: mfg_process_template_item mfg_process_template_item_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_process_template_item
    ADD CONSTRAINT mfg_process_template_item_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.mfg_operation(id);


--
-- Name: mfg_process_template_item mfg_process_template_item_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_process_template_item
    ADD CONSTRAINT mfg_process_template_item_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.mfg_process_template(id) ON DELETE CASCADE;


--
-- Name: mfg_work_order mfg_work_order_bom_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order
    ADD CONSTRAINT mfg_work_order_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES public.mfg_bom(id) ON DELETE SET NULL;


--
-- Name: mfg_work_order_byproduct mfg_work_order_byproduct_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order_byproduct
    ADD CONSTRAINT mfg_work_order_byproduct_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: mfg_work_order_byproduct mfg_work_order_byproduct_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order_byproduct
    ADD CONSTRAINT mfg_work_order_byproduct_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: mfg_work_order_byproduct mfg_work_order_byproduct_work_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order_byproduct
    ADD CONSTRAINT mfg_work_order_byproduct_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES public.mfg_work_order(id) ON DELETE CASCADE;


--
-- Name: mfg_work_order mfg_work_order_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order
    ADD CONSTRAINT mfg_work_order_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: mfg_work_order_component mfg_work_order_component_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order_component
    ADD CONSTRAINT mfg_work_order_component_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: mfg_work_order_component mfg_work_order_component_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order_component
    ADD CONSTRAINT mfg_work_order_component_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: mfg_work_order_component mfg_work_order_component_work_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order_component
    ADD CONSTRAINT mfg_work_order_component_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES public.mfg_work_order(id) ON DELETE CASCADE;


--
-- Name: mfg_work_order mfg_work_order_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order
    ADD CONSTRAINT mfg_work_order_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: mfg_work_order mfg_work_order_demand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order
    ADD CONSTRAINT mfg_work_order_demand_id_fkey FOREIGN KEY (demand_id) REFERENCES public.mfg_demand(id) ON DELETE RESTRICT;


--
-- Name: mfg_work_order mfg_work_order_demand_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order
    ADD CONSTRAINT mfg_work_order_demand_item_id_fkey FOREIGN KEY (demand_item_id) REFERENCES public.mfg_demand_item(id) ON DELETE RESTRICT;


--
-- Name: mfg_work_order mfg_work_order_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order
    ADD CONSTRAINT mfg_work_order_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id) ON DELETE RESTRICT;


--
-- Name: mfg_work_order mfg_work_order_owner_dept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order
    ADD CONSTRAINT mfg_work_order_owner_dept_id_fkey FOREIGN KEY (owner_dept_id) REFERENCES public.sys_department(id);


--
-- Name: mfg_work_order_route mfg_work_order_route_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order_route
    ADD CONSTRAINT mfg_work_order_route_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.mfg_operation(id);


--
-- Name: mfg_work_order_route mfg_work_order_route_work_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order_route
    ADD CONSTRAINT mfg_work_order_route_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES public.mfg_work_order(id) ON DELETE CASCADE;


--
-- Name: mfg_work_order mfg_work_order_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfg_work_order
    ADD CONSTRAINT mfg_work_order_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: pur_order pur_order_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order
    ADD CONSTRAINT pur_order_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: pur_order pur_order_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order
    ADD CONSTRAINT pur_order_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_order pur_order_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order
    ADD CONSTRAINT pur_order_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: pur_order pur_order_currency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order
    ADD CONSTRAINT pur_order_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES public.bas_currency(id);


--
-- Name: pur_order_item pur_order_item_bom_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item
    ADD CONSTRAINT pur_order_item_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES public.mfg_bom(id) ON DELETE SET NULL;


--
-- Name: pur_order_item_byproduct pur_order_item_byproduct_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item_byproduct
    ADD CONSTRAINT pur_order_item_byproduct_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_order_item_byproduct pur_order_item_byproduct_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item_byproduct
    ADD CONSTRAINT pur_order_item_byproduct_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: pur_order_item_byproduct pur_order_item_byproduct_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item_byproduct
    ADD CONSTRAINT pur_order_item_byproduct_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.pur_order_item(id) ON DELETE CASCADE;


--
-- Name: pur_order_item_byproduct pur_order_item_byproduct_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item_byproduct
    ADD CONSTRAINT pur_order_item_byproduct_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: pur_order_item pur_order_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item
    ADD CONSTRAINT pur_order_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_order_item pur_order_item_demand_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item
    ADD CONSTRAINT pur_order_item_demand_line_id_fkey FOREIGN KEY (demand_line_id) REFERENCES public.mfg_demand_item(id) ON DELETE RESTRICT;


--
-- Name: pur_order_item_material pur_order_item_material_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item_material
    ADD CONSTRAINT pur_order_item_material_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_order_item pur_order_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item
    ADD CONSTRAINT pur_order_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: pur_order_item_material pur_order_item_material_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item_material
    ADD CONSTRAINT pur_order_item_material_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: pur_order_item_material pur_order_item_material_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item_material
    ADD CONSTRAINT pur_order_item_material_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.pur_order_item(id) ON DELETE CASCADE;


--
-- Name: pur_order_item_material pur_order_item_material_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item_material
    ADD CONSTRAINT pur_order_item_material_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: pur_order_item pur_order_item_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item
    ADD CONSTRAINT pur_order_item_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.pur_order(id) ON DELETE CASCADE;


--
-- Name: pur_order_item pur_order_item_quotation_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item
    ADD CONSTRAINT pur_order_item_quotation_item_id_fkey FOREIGN KEY (quotation_item_id) REFERENCES public.pur_quotation_item(id);


--
-- Name: pur_order_item pur_order_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_order_item
    ADD CONSTRAINT pur_order_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: pur_outsourced_issue pur_outsourced_issue_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue
    ADD CONSTRAINT pur_outsourced_issue_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: pur_outsourced_issue pur_outsourced_issue_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue
    ADD CONSTRAINT pur_outsourced_issue_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_outsourced_issue pur_outsourced_issue_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue
    ADD CONSTRAINT pur_outsourced_issue_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: pur_outsourced_issue pur_outsourced_issue_from_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue
    ADD CONSTRAINT pur_outsourced_issue_from_warehouse_id_fkey FOREIGN KEY (from_warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: pur_outsourced_issue_item pur_outsourced_issue_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue_item
    ADD CONSTRAINT pur_outsourced_issue_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_outsourced_issue_item pur_outsourced_issue_item_from_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue_item
    ADD CONSTRAINT pur_outsourced_issue_item_from_warehouse_id_fkey FOREIGN KEY (from_warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: pur_outsourced_issue_item pur_outsourced_issue_item_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue_item
    ADD CONSTRAINT pur_outsourced_issue_item_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES public.pur_outsourced_issue(id) ON DELETE CASCADE;


--
-- Name: pur_outsourced_issue_item pur_outsourced_issue_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue_item
    ADD CONSTRAINT pur_outsourced_issue_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: pur_outsourced_issue_item pur_outsourced_issue_item_order_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue_item
    ADD CONSTRAINT pur_outsourced_issue_item_order_item_material_id_fkey FOREIGN KEY (order_item_material_id) REFERENCES public.pur_order_item_material(id);


--
-- Name: pur_outsourced_issue_item pur_outsourced_issue_item_outsourced_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue_item
    ADD CONSTRAINT pur_outsourced_issue_item_outsourced_warehouse_id_fkey FOREIGN KEY (outsourced_warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: pur_outsourced_issue_item pur_outsourced_issue_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue_item
    ADD CONSTRAINT pur_outsourced_issue_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: pur_outsourced_issue pur_outsourced_issue_outsourced_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_issue
    ADD CONSTRAINT pur_outsourced_issue_outsourced_warehouse_id_fkey FOREIGN KEY (outsourced_warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: pur_outsourced_receipt pur_outsourced_receipt_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt
    ADD CONSTRAINT pur_outsourced_receipt_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: pur_outsourced_receipt pur_outsourced_receipt_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt
    ADD CONSTRAINT pur_outsourced_receipt_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_outsourced_receipt pur_outsourced_receipt_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt
    ADD CONSTRAINT pur_outsourced_receipt_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: pur_outsourced_receipt pur_outsourced_receipt_credit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt
    ADD CONSTRAINT pur_outsourced_receipt_credit_account_id_fkey FOREIGN KEY (credit_account_id) REFERENCES public.bas_account(id);


--
-- Name: pur_outsourced_receipt pur_outsourced_receipt_debit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt
    ADD CONSTRAINT pur_outsourced_receipt_debit_account_id_fkey FOREIGN KEY (debit_account_id) REFERENCES public.bas_account(id);


--
-- Name: pur_outsourced_receipt_item_byproduct pur_outsourced_receipt_item_byproduct_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_byproduct
    ADD CONSTRAINT pur_outsourced_receipt_item_byproduct_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_outsourced_receipt_item_byproduct pur_outsourced_receipt_item_byproduct_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_byproduct
    ADD CONSTRAINT pur_outsourced_receipt_item_byproduct_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: pur_outsourced_receipt_item_byproduct pur_outsourced_receipt_item_byproduct_order_item_byproduct_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_byproduct
    ADD CONSTRAINT pur_outsourced_receipt_item_byproduct_order_item_byproduct_id_f FOREIGN KEY (order_item_byproduct_id) REFERENCES public.pur_order_item_byproduct(id);


--
-- Name: pur_outsourced_receipt_item_byproduct pur_outsourced_receipt_item_byproduct_receipt_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_byproduct
    ADD CONSTRAINT pur_outsourced_receipt_item_byproduct_receipt_item_id_fkey FOREIGN KEY (receipt_item_id) REFERENCES public.pur_outsourced_receipt_item(id) ON DELETE CASCADE;


--
-- Name: pur_outsourced_receipt_item_byproduct pur_outsourced_receipt_item_byproduct_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_byproduct
    ADD CONSTRAINT pur_outsourced_receipt_item_byproduct_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: pur_outsourced_receipt_item_byproduct pur_outsourced_receipt_item_byproduct_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_byproduct
    ADD CONSTRAINT pur_outsourced_receipt_item_byproduct_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: pur_outsourced_receipt_item pur_outsourced_receipt_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item
    ADD CONSTRAINT pur_outsourced_receipt_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_outsourced_receipt_item_material pur_outsourced_receipt_item_material_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_material
    ADD CONSTRAINT pur_outsourced_receipt_item_material_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_outsourced_receipt_item pur_outsourced_receipt_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item
    ADD CONSTRAINT pur_outsourced_receipt_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: pur_outsourced_receipt_item_material pur_outsourced_receipt_item_material_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_material
    ADD CONSTRAINT pur_outsourced_receipt_item_material_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: pur_outsourced_receipt_item_material pur_outsourced_receipt_item_material_order_item_material_id_fke; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_material
    ADD CONSTRAINT pur_outsourced_receipt_item_material_order_item_material_id_fke FOREIGN KEY (order_item_material_id) REFERENCES public.pur_order_item_material(id);


--
-- Name: pur_outsourced_receipt_item_material pur_outsourced_receipt_item_material_outsourced_warehouse_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_material
    ADD CONSTRAINT pur_outsourced_receipt_item_material_outsourced_warehouse_id_fk FOREIGN KEY (outsourced_warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: pur_outsourced_receipt_item_material pur_outsourced_receipt_item_material_receipt_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_material
    ADD CONSTRAINT pur_outsourced_receipt_item_material_receipt_item_id_fkey FOREIGN KEY (receipt_item_id) REFERENCES public.pur_outsourced_receipt_item(id) ON DELETE CASCADE;


--
-- Name: pur_outsourced_receipt_item_material pur_outsourced_receipt_item_material_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item_material
    ADD CONSTRAINT pur_outsourced_receipt_item_material_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: pur_outsourced_receipt_item pur_outsourced_receipt_item_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item
    ADD CONSTRAINT pur_outsourced_receipt_item_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.pur_order_item(id);


--
-- Name: pur_outsourced_receipt_item pur_outsourced_receipt_item_receipt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item
    ADD CONSTRAINT pur_outsourced_receipt_item_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES public.pur_outsourced_receipt(id) ON DELETE CASCADE;


--
-- Name: pur_outsourced_receipt_item pur_outsourced_receipt_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item
    ADD CONSTRAINT pur_outsourced_receipt_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: pur_outsourced_receipt_item pur_outsourced_receipt_item_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt_item
    ADD CONSTRAINT pur_outsourced_receipt_item_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: pur_outsourced_receipt pur_outsourced_receipt_outsourced_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt
    ADD CONSTRAINT pur_outsourced_receipt_outsourced_warehouse_id_fkey FOREIGN KEY (outsourced_warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: pur_outsourced_receipt pur_outsourced_receipt_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_outsourced_receipt
    ADD CONSTRAINT pur_outsourced_receipt_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: pur_quotation pur_quotation_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation
    ADD CONSTRAINT pur_quotation_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: pur_quotation pur_quotation_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation
    ADD CONSTRAINT pur_quotation_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_quotation pur_quotation_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation
    ADD CONSTRAINT pur_quotation_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: pur_quotation pur_quotation_currency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation
    ADD CONSTRAINT pur_quotation_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES public.bas_currency(id);


--
-- Name: pur_quotation_item pur_quotation_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation_item
    ADD CONSTRAINT pur_quotation_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_quotation_item pur_quotation_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation_item
    ADD CONSTRAINT pur_quotation_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: pur_quotation_item pur_quotation_item_quotation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation_item
    ADD CONSTRAINT pur_quotation_item_quotation_id_fkey FOREIGN KEY (quotation_id) REFERENCES public.pur_quotation(id) ON DELETE CASCADE;


--
-- Name: pur_quotation_item pur_quotation_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation_item
    ADD CONSTRAINT pur_quotation_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: pur_quotation_tier pur_quotation_tier_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation_tier
    ADD CONSTRAINT pur_quotation_tier_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_quotation_tier pur_quotation_tier_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_quotation_tier
    ADD CONSTRAINT pur_quotation_tier_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.pur_quotation_item(id) ON DELETE CASCADE;


--
-- Name: pur_receipt pur_receipt_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt
    ADD CONSTRAINT pur_receipt_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: pur_receipt pur_receipt_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt
    ADD CONSTRAINT pur_receipt_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_receipt pur_receipt_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt
    ADD CONSTRAINT pur_receipt_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: pur_receipt pur_receipt_credit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt
    ADD CONSTRAINT pur_receipt_credit_account_id_fkey FOREIGN KEY (credit_account_id) REFERENCES public.bas_account(id);


--
-- Name: pur_receipt pur_receipt_debit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt
    ADD CONSTRAINT pur_receipt_debit_account_id_fkey FOREIGN KEY (debit_account_id) REFERENCES public.bas_account(id);


--
-- Name: pur_receipt_item pur_receipt_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt_item
    ADD CONSTRAINT pur_receipt_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_receipt_item pur_receipt_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt_item
    ADD CONSTRAINT pur_receipt_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: pur_receipt_item pur_receipt_item_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt_item
    ADD CONSTRAINT pur_receipt_item_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.pur_order_item(id);


--
-- Name: pur_receipt_item pur_receipt_item_receipt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt_item
    ADD CONSTRAINT pur_receipt_item_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES public.pur_receipt(id) ON DELETE CASCADE;


--
-- Name: pur_receipt_item pur_receipt_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt_item
    ADD CONSTRAINT pur_receipt_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: pur_receipt_item pur_receipt_item_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt_item
    ADD CONSTRAINT pur_receipt_item_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: pur_receipt pur_receipt_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_receipt
    ADD CONSTRAINT pur_receipt_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: pur_reconciliation pur_reconciliation_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_reconciliation
    ADD CONSTRAINT pur_reconciliation_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_reconciliation pur_reconciliation_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_reconciliation
    ADD CONSTRAINT pur_reconciliation_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: pur_reconciliation pur_reconciliation_credit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_reconciliation
    ADD CONSTRAINT pur_reconciliation_credit_account_id_fkey FOREIGN KEY (credit_account_id) REFERENCES public.bas_account(id);


--
-- Name: pur_reconciliation pur_reconciliation_debit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_reconciliation
    ADD CONSTRAINT pur_reconciliation_debit_account_id_fkey FOREIGN KEY (debit_account_id) REFERENCES public.bas_account(id);


--
-- Name: pur_reconciliation_item pur_reconciliation_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_reconciliation_item
    ADD CONSTRAINT pur_reconciliation_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: pur_reconciliation_item pur_reconciliation_item_outsourced_receipt_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_reconciliation_item
    ADD CONSTRAINT pur_reconciliation_item_outsourced_receipt_item_id_fkey FOREIGN KEY (outsourced_receipt_item_id) REFERENCES public.pur_outsourced_receipt_item(id);


--
-- Name: pur_reconciliation_item pur_reconciliation_item_receipt_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_reconciliation_item
    ADD CONSTRAINT pur_reconciliation_item_receipt_item_id_fkey FOREIGN KEY (receipt_item_id) REFERENCES public.pur_receipt_item(id);


--
-- Name: pur_reconciliation_item pur_reconciliation_item_reconciliation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pur_reconciliation_item
    ADD CONSTRAINT pur_reconciliation_item_reconciliation_id_fkey FOREIGN KEY (reconciliation_id) REFERENCES public.pur_reconciliation(id) ON DELETE CASCADE;


--
-- Name: sal_company_account_default sal_company_account_default_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_company_account_default
    ADD CONSTRAINT sal_company_account_default_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sal_company_account_default sal_company_account_default_delivery_credit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_company_account_default
    ADD CONSTRAINT sal_company_account_default_delivery_credit_account_id_fkey FOREIGN KEY (delivery_credit_account_id) REFERENCES public.bas_account(id);


--
-- Name: sal_company_account_default sal_company_account_default_delivery_debit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_company_account_default
    ADD CONSTRAINT sal_company_account_default_delivery_debit_account_id_fkey FOREIGN KEY (delivery_debit_account_id) REFERENCES public.bas_account(id);


--
-- Name: sal_company_account_default sal_company_account_default_receipt_credit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_company_account_default
    ADD CONSTRAINT sal_company_account_default_receipt_credit_account_id_fkey FOREIGN KEY (receipt_credit_account_id) REFERENCES public.bas_account(id);


--
-- Name: sal_company_account_default sal_company_account_default_receipt_debit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_company_account_default
    ADD CONSTRAINT sal_company_account_default_receipt_debit_account_id_fkey FOREIGN KEY (receipt_debit_account_id) REFERENCES public.bas_account(id);


--
-- Name: sal_delivery sal_delivery_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery
    ADD CONSTRAINT sal_delivery_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: sal_delivery sal_delivery_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery
    ADD CONSTRAINT sal_delivery_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sal_delivery sal_delivery_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery
    ADD CONSTRAINT sal_delivery_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: sal_delivery sal_delivery_credit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery
    ADD CONSTRAINT sal_delivery_credit_account_id_fkey FOREIGN KEY (credit_account_id) REFERENCES public.bas_account(id);


--
-- Name: sal_delivery sal_delivery_debit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery
    ADD CONSTRAINT sal_delivery_debit_account_id_fkey FOREIGN KEY (debit_account_id) REFERENCES public.bas_account(id);


--
-- Name: sal_delivery_item sal_delivery_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_item
    ADD CONSTRAINT sal_delivery_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sal_delivery_item sal_delivery_item_delivery_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_item
    ADD CONSTRAINT sal_delivery_item_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.sal_delivery(id) ON DELETE CASCADE;


--
-- Name: sal_delivery_item sal_delivery_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_item
    ADD CONSTRAINT sal_delivery_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: sal_delivery_item sal_delivery_item_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_item
    ADD CONSTRAINT sal_delivery_item_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.sal_order_item(id);


--
-- Name: sal_delivery_item sal_delivery_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_item
    ADD CONSTRAINT sal_delivery_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: sal_delivery_item sal_delivery_item_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_item
    ADD CONSTRAINT sal_delivery_item_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: sal_delivery_pack_box sal_delivery_pack_box_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_pack_box
    ADD CONSTRAINT sal_delivery_pack_box_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sal_delivery_pack_box sal_delivery_pack_box_delivery_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_pack_box
    ADD CONSTRAINT sal_delivery_pack_box_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.sal_delivery(id) ON DELETE CASCADE;


--
-- Name: sal_delivery_pack_line sal_delivery_pack_line_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sal_delivery_pack_line sal_delivery_pack_line_delivery_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.sal_delivery(id) ON DELETE CASCADE;


--
-- Name: sal_delivery_pack_line sal_delivery_pack_line_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: sal_delivery_pack_line sal_delivery_pack_line_pack_box_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_pack_box_id_fkey FOREIGN KEY (pack_box_id) REFERENCES public.sal_delivery_pack_box(id) ON DELETE CASCADE;


--
-- Name: sal_delivery_pack_line sal_delivery_pack_line_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: sal_delivery sal_delivery_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_delivery
    ADD CONSTRAINT sal_delivery_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id);


--
-- Name: sal_order sal_order_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_order
    ADD CONSTRAINT sal_order_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: sal_order sal_order_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_order
    ADD CONSTRAINT sal_order_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sal_order sal_order_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_order
    ADD CONSTRAINT sal_order_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: sal_order sal_order_currency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_order
    ADD CONSTRAINT sal_order_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES public.bas_currency(id);


--
-- Name: sal_order_item sal_order_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_order_item
    ADD CONSTRAINT sal_order_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sal_order_item sal_order_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_order_item
    ADD CONSTRAINT sal_order_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: sal_order_item sal_order_item_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_order_item
    ADD CONSTRAINT sal_order_item_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.sal_order(id) ON DELETE CASCADE;


--
-- Name: sal_order_item sal_order_item_quotation_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_order_item
    ADD CONSTRAINT sal_order_item_quotation_item_id_fkey FOREIGN KEY (quotation_item_id) REFERENCES public.sal_quotation_item(id);


--
-- Name: sal_order_item sal_order_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_order_item
    ADD CONSTRAINT sal_order_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: sal_quotation sal_quotation_audited_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation
    ADD CONSTRAINT sal_quotation_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id);


--
-- Name: sal_quotation sal_quotation_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation
    ADD CONSTRAINT sal_quotation_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sal_quotation sal_quotation_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation
    ADD CONSTRAINT sal_quotation_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: sal_quotation sal_quotation_currency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation
    ADD CONSTRAINT sal_quotation_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES public.bas_currency(id);


--
-- Name: sal_quotation_item sal_quotation_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation_item
    ADD CONSTRAINT sal_quotation_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sal_quotation_item sal_quotation_item_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation_item
    ADD CONSTRAINT sal_quotation_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);


--
-- Name: sal_quotation_item sal_quotation_item_quotation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation_item
    ADD CONSTRAINT sal_quotation_item_quotation_id_fkey FOREIGN KEY (quotation_id) REFERENCES public.sal_quotation(id) ON DELETE CASCADE;


--
-- Name: sal_quotation_item sal_quotation_item_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation_item
    ADD CONSTRAINT sal_quotation_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);


--
-- Name: sal_quotation_tier sal_quotation_tier_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation_tier
    ADD CONSTRAINT sal_quotation_tier_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sal_quotation_tier sal_quotation_tier_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_quotation_tier
    ADD CONSTRAINT sal_quotation_tier_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.sal_quotation_item(id) ON DELETE CASCADE;


--
-- Name: sal_reconciliation sal_reconciliation_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_reconciliation
    ADD CONSTRAINT sal_reconciliation_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sal_reconciliation sal_reconciliation_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_reconciliation
    ADD CONSTRAINT sal_reconciliation_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: sal_reconciliation sal_reconciliation_credit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_reconciliation
    ADD CONSTRAINT sal_reconciliation_credit_account_id_fkey FOREIGN KEY (credit_account_id) REFERENCES public.bas_account(id);


--
-- Name: sal_reconciliation sal_reconciliation_debit_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_reconciliation
    ADD CONSTRAINT sal_reconciliation_debit_account_id_fkey FOREIGN KEY (debit_account_id) REFERENCES public.bas_account(id);


--
-- Name: sal_reconciliation_item sal_reconciliation_item_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_reconciliation_item
    ADD CONSTRAINT sal_reconciliation_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sal_reconciliation_item sal_reconciliation_item_delivery_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_reconciliation_item
    ADD CONSTRAINT sal_reconciliation_item_delivery_item_id_fkey FOREIGN KEY (delivery_item_id) REFERENCES public.sal_delivery_item(id);


--
-- Name: sal_reconciliation_item sal_reconciliation_item_reconciliation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sal_reconciliation_item
    ADD CONSTRAINT sal_reconciliation_item_reconciliation_id_fkey FOREIGN KEY (reconciliation_id) REFERENCES public.sal_reconciliation(id) ON DELETE CASCADE;


--
-- Name: sys_attachment sys_attachment_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_attachment
    ADD CONSTRAINT sys_attachment_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.sys_file(id);


--
-- Name: sys_department sys_department_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_department
    ADD CONSTRAINT sys_department_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sys_department sys_department_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_department
    ADD CONSTRAINT sys_department_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.sys_department(id);


--
-- Name: sys_file sys_file_uploaded_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_file
    ADD CONSTRAINT sys_file_uploaded_by_id_fkey FOREIGN KEY (uploaded_by_id) REFERENCES public.sys_user(id);


--
-- Name: sys_numbering_counter sys_numbering_counter_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_numbering_counter
    ADD CONSTRAINT sys_numbering_counter_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.sys_numbering_rule(id) ON DELETE CASCADE;


--
-- Name: sys_print_template sys_print_template_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_print_template
    ADD CONSTRAINT sys_print_template_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.sys_file(id);


--
-- Name: sys_role_menu sys_role_menu_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_role_menu
    ADD CONSTRAINT sys_role_menu_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.sys_role(id);


--
-- Name: sys_role_permission sys_role_permission_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_role_permission
    ADD CONSTRAINT sys_role_permission_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.sys_role(id);


--
-- Name: sys_todo sys_todo_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_todo
    ADD CONSTRAINT sys_todo_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sys_todo sys_todo_created_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_todo
    ADD CONSTRAINT sys_todo_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id);


--
-- Name: sys_todo_state sys_todo_state_todo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_todo_state
    ADD CONSTRAINT sys_todo_state_todo_id_fkey FOREIGN KEY (todo_id) REFERENCES public.sys_todo(id) ON DELETE CASCADE;


--
-- Name: sys_todo_state sys_todo_state_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_todo_state
    ADD CONSTRAINT sys_todo_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.sys_user(id);


--
-- Name: sys_user sys_user_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_user
    ADD CONSTRAINT sys_user_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES public.auth_user(id);


--
-- Name: sys_user_company sys_user_company_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_user_company
    ADD CONSTRAINT sys_user_company_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);


--
-- Name: sys_user_company sys_user_company_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_user_company
    ADD CONSTRAINT sys_user_company_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.sys_user(id);


--
-- Name: sys_user sys_user_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_user
    ADD CONSTRAINT sys_user_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.sys_department(id);


--
-- Name: sys_user_role sys_user_role_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_user_role
    ADD CONSTRAINT sys_user_role_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.sys_role(id);


--
-- Name: sys_user_role sys_user_role_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sys_user_role
    ADD CONSTRAINT sys_user_role_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.sys_user(id);


--
-- PostgreSQL database dump complete
--


