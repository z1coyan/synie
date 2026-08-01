/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as candidateRepair from "../candidateRepair.js";
import type * as catalog_all from "../catalog/all.js";
import type * as catalog_get from "../catalog/get.js";
import type * as catalog_permissions from "../catalog/permissions.js";
import type * as catalog_pilots from "../catalog/pilots.js";
import type * as crons from "../crons.js";
import type * as domains_accounting_documents from "../domains/accounting/documents.js";
import type * as domains_accounting_drafts from "../domains/accounting/drafts.js";
import type * as domains_accounting_reports from "../domains/accounting/reports.js";
import type * as domains_base_accounts from "../domains/base/accounts.js";
import type * as domains_base_companies from "../domains/base/companies.js";
import type * as domains_commands from "../domains/commands.js";
import type * as domains_finance_bankImport from "../domains/finance/bankImport.js";
import type * as domains_finance_bankImportActions from "../domains/finance/bankImportActions.js";
import type * as domains_finance_banking from "../domains/finance/banking.js";
import type * as domains_finance_bills from "../domains/finance/bills.js";
import type * as domains_finance_documents from "../domains/finance/documents.js";
import type * as domains_finance_drafts from "../domains/finance/drafts.js";
import type * as domains_finance_ocr from "../domains/finance/ocr.js";
import type * as domains_finance_ocrActions from "../domains/finance/ocrActions.js";
import type * as domains_hr_attendance from "../domains/hr/attendance.js";
import type * as domains_hr_attendanceImport from "../domains/hr/attendanceImport.js";
import type * as domains_hr_attendanceImportActions from "../domains/hr/attendanceImportActions.js";
import type * as domains_hr_attendanceRules from "../domains/hr/attendanceRules.js";
import type * as domains_hr_domain from "../domains/hr/domain.js";
import type * as domains_hr_payroll from "../domains/hr/payroll.js";
import type * as domains_inventory_documents from "../domains/inventory/documents.js";
import type * as domains_inventory_drafts from "../domains/inventory/drafts.js";
import type * as domains_inventory_master from "../domains/inventory/master.js";
import type * as domains_inventory_operations from "../domains/inventory/operations.js";
import type * as domains_inventory_revisions from "../domains/inventory/revisions.js";
import type * as domains_manufacturing_arrangements from "../domains/manufacturing/arrangements.js";
import type * as domains_manufacturing_domain from "../domains/manufacturing/domain.js";
import type * as domains_manufacturing_drafts from "../domains/manufacturing/drafts.js";
import type * as domains_market_actions from "../domains/market/actions.js";
import type * as domains_market_domain from "../domains/market/domain.js";
import type * as domains_party_parties from "../domains/party/parties.js";
import type * as domains_platform_companyAccountDefaults from "../domains/platform/companyAccountDefaults.js";
import type * as domains_platform_numbering from "../domains/platform/numbering.js";
import type * as domains_platform_resources from "../domains/platform/resources.js";
import type * as domains_platform_settings from "../domains/platform/settings.js";
import type * as domains_platform_settingsSeed from "../domains/platform/settingsSeed.js";
import type * as domains_shared_aggregate from "../domains/shared/aggregate.js";
import type * as domains_shared_api from "../domains/shared/api.js";
import type * as domains_shared_candidates from "../domains/shared/candidates.js";
import type * as domains_shared_policies from "../domains/shared/policies.js";
import type * as domains_shared_queryProfiles from "../domains/shared/queryProfiles.js";
import type * as domains_shared_records from "../domains/shared/records.js";
import type * as domains_shared_snapshots from "../domains/shared/snapshots.js";
import type * as domains_todo_domain from "../domains/todo/domain.js";
import type * as domains_trading_drafts from "../domains/trading/drafts.js";
import type * as domains_trading_fulfillment from "../domains/trading/fulfillment.js";
import type * as domains_trading_fulfillmentDrafts from "../domains/trading/fulfillmentDrafts.js";
import type * as domains_trading_operations from "../domains/trading/operations.js";
import type * as domains_trading_orders from "../domains/trading/orders.js";
import type * as domains_trading_quotations from "../domains/trading/quotations.js";
import type * as domains_trading_reconciliation from "../domains/trading/reconciliation.js";
import type * as domains_trading_reconciliationDrafts from "../domains/trading/reconciliationDrafts.js";
import type * as engines_generation from "../engines/generation.js";
import type * as engines_gl_engine from "../engines/gl/engine.js";
import type * as engines_gl_model from "../engines/gl/model.js";
import type * as engines_gl_projections from "../engines/gl/projections.js";
import type * as engines_inventory_engine from "../engines/inventory/engine.js";
import type * as engines_inventory_model from "../engines/inventory/model.js";
import type * as engines_inventory_projections from "../engines/inventory/projections.js";
import type * as engines_posting_orchestrator from "../engines/posting/orchestrator.js";
import type * as engines_reconciliation_model from "../engines/reconciliation/model.js";
import type * as engines_reconciliation_rebuild from "../engines/reconciliation/rebuild.js";
import type * as engines_shared from "../engines/shared.js";
import type * as files_actions from "../files/actions.js";
import type * as files_domain from "../files/domain.js";
import type * as files_maintenance from "../files/maintenance.js";
import type * as files_owners from "../files/owners.js";
import type * as files_s3 from "../files/s3.js";
import type * as http from "../http.js";
import type * as iam_loginRateLimit from "../iam/loginRateLimit.js";
import type * as iam_me from "../iam/me.js";
import type * as iam_model from "../iam/model.js";
import type * as iam_principal from "../iam/principal.js";
import type * as iam_probe from "../iam/probe.js";
import type * as iam_roles from "../iam/roles.js";
import type * as iam_users from "../iam/users.js";
import type * as infraRestore from "../infraRestore.js";
import type * as jobs_domain from "../jobs/domain.js";
import type * as jobs_model from "../jobs/model.js";
import type * as jobs_runner from "../jobs/runner.js";
import type * as lib_actor from "../lib/actor.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_authPolicy from "../lib/authPolicy.js";
import type * as lib_budget from "../lib/budget.js";
import type * as lib_companyScope from "../lib/companyScope.js";
import type * as lib_dates from "../lib/dates.js";
import type * as lib_decimal from "../lib/decimal.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_idempotency from "../lib/idempotency.js";
import type * as lib_ids from "../lib/ids.js";
import type * as lib_invariants from "../lib/invariants.js";
import type * as lib_mutationContext from "../lib/mutationContext.js";
import type * as lib_pagination from "../lib/pagination.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_queryProfiles from "../lib/queryProfiles.js";
import type * as lib_username from "../lib/username.js";
import type * as migration_closureManifest from "../migration/closureManifest.js";
import type * as migration_decimalManifest from "../migration/decimalManifest.js";
import type * as migration_engineMatrix from "../migration/engineMatrix.js";
import type * as migration_engineQueryProfiles from "../migration/engineQueryProfiles.js";
import type * as migration_ioManifest from "../migration/ioManifest.js";
import type * as migration_resourceManifest from "../migration/resourceManifest.js";
import type * as migration_tableManifest from "../migration/tableManifest.js";
import type * as platform_audit_model from "../platform/audit/model.js";
import type * as platform_audit_write from "../platform/audit/write.js";
import type * as platform_numbering_catalog from "../platform/numbering/catalog.js";
import type * as platform_numbering_defaults from "../platform/numbering/defaults.js";
import type * as platform_numbering_model from "../platform/numbering/model.js";
import type * as platform_numbering_service from "../platform/numbering/service.js";
import type * as platform_printing_actions from "../platform/printing/actions.js";
import type * as platform_printing_builders from "../platform/printing/builders.js";
import type * as platform_printing_catalog from "../platform/printing/catalog.js";
import type * as platform_printing_format from "../platform/printing/format.js";
import type * as platform_printing_jobs from "../platform/printing/jobs.js";
import type * as platform_printing_policy from "../platform/printing/policy.js";
import type * as platform_printing_renderer from "../platform/printing/renderer.js";
import type * as platform_printing_templates from "../platform/printing/templates.js";
import type * as platform_printing_types from "../platform/printing/types.js";
import type * as platform_printing_xlsx from "../platform/printing/xlsx.js";
import type * as platform_printing_zip from "../platform/printing/zip.js";
import type * as reconciliation from "../reconciliation.js";
import type * as resources_currencies from "../resources/currencies.js";
import type * as resources_ioProbe from "../resources/ioProbe.js";
import type * as resources_model from "../resources/model.js";
import type * as resources_probe from "../resources/probe.js";
import type * as resources_units from "../resources/units.js";
import type * as resources_warehouseSeed from "../resources/warehouseSeed.js";
import type * as resources_warehouses from "../resources/warehouses.js";
import type * as setup_complete from "../setup/complete.js";
import type * as setup_core from "../setup/core.js";
import type * as setup_createFirstUser from "../setup/createFirstUser.js";
import type * as setup_model from "../setup/model.js";
import type * as setup_sample from "../setup/sample.js";
import type * as setup_sampleAction from "../setup/sampleAction.js";
import type * as setup_seeds from "../setup/seeds.js";
import type * as setup_spike from "../setup/spike.js";
import type * as setup_state from "../setup/state.js";
import type * as setup_status from "../setup/status.js";
import type * as test_engineProbe from "../test/engineProbe.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  candidateRepair: typeof candidateRepair;
  "catalog/all": typeof catalog_all;
  "catalog/get": typeof catalog_get;
  "catalog/permissions": typeof catalog_permissions;
  "catalog/pilots": typeof catalog_pilots;
  crons: typeof crons;
  "domains/accounting/documents": typeof domains_accounting_documents;
  "domains/accounting/drafts": typeof domains_accounting_drafts;
  "domains/accounting/reports": typeof domains_accounting_reports;
  "domains/base/accounts": typeof domains_base_accounts;
  "domains/base/companies": typeof domains_base_companies;
  "domains/commands": typeof domains_commands;
  "domains/finance/bankImport": typeof domains_finance_bankImport;
  "domains/finance/bankImportActions": typeof domains_finance_bankImportActions;
  "domains/finance/banking": typeof domains_finance_banking;
  "domains/finance/bills": typeof domains_finance_bills;
  "domains/finance/documents": typeof domains_finance_documents;
  "domains/finance/drafts": typeof domains_finance_drafts;
  "domains/finance/ocr": typeof domains_finance_ocr;
  "domains/finance/ocrActions": typeof domains_finance_ocrActions;
  "domains/hr/attendance": typeof domains_hr_attendance;
  "domains/hr/attendanceImport": typeof domains_hr_attendanceImport;
  "domains/hr/attendanceImportActions": typeof domains_hr_attendanceImportActions;
  "domains/hr/attendanceRules": typeof domains_hr_attendanceRules;
  "domains/hr/domain": typeof domains_hr_domain;
  "domains/hr/payroll": typeof domains_hr_payroll;
  "domains/inventory/documents": typeof domains_inventory_documents;
  "domains/inventory/drafts": typeof domains_inventory_drafts;
  "domains/inventory/master": typeof domains_inventory_master;
  "domains/inventory/operations": typeof domains_inventory_operations;
  "domains/inventory/revisions": typeof domains_inventory_revisions;
  "domains/manufacturing/arrangements": typeof domains_manufacturing_arrangements;
  "domains/manufacturing/domain": typeof domains_manufacturing_domain;
  "domains/manufacturing/drafts": typeof domains_manufacturing_drafts;
  "domains/market/actions": typeof domains_market_actions;
  "domains/market/domain": typeof domains_market_domain;
  "domains/party/parties": typeof domains_party_parties;
  "domains/platform/companyAccountDefaults": typeof domains_platform_companyAccountDefaults;
  "domains/platform/numbering": typeof domains_platform_numbering;
  "domains/platform/resources": typeof domains_platform_resources;
  "domains/platform/settings": typeof domains_platform_settings;
  "domains/platform/settingsSeed": typeof domains_platform_settingsSeed;
  "domains/shared/aggregate": typeof domains_shared_aggregate;
  "domains/shared/api": typeof domains_shared_api;
  "domains/shared/candidates": typeof domains_shared_candidates;
  "domains/shared/policies": typeof domains_shared_policies;
  "domains/shared/queryProfiles": typeof domains_shared_queryProfiles;
  "domains/shared/records": typeof domains_shared_records;
  "domains/shared/snapshots": typeof domains_shared_snapshots;
  "domains/todo/domain": typeof domains_todo_domain;
  "domains/trading/drafts": typeof domains_trading_drafts;
  "domains/trading/fulfillment": typeof domains_trading_fulfillment;
  "domains/trading/fulfillmentDrafts": typeof domains_trading_fulfillmentDrafts;
  "domains/trading/operations": typeof domains_trading_operations;
  "domains/trading/orders": typeof domains_trading_orders;
  "domains/trading/quotations": typeof domains_trading_quotations;
  "domains/trading/reconciliation": typeof domains_trading_reconciliation;
  "domains/trading/reconciliationDrafts": typeof domains_trading_reconciliationDrafts;
  "engines/generation": typeof engines_generation;
  "engines/gl/engine": typeof engines_gl_engine;
  "engines/gl/model": typeof engines_gl_model;
  "engines/gl/projections": typeof engines_gl_projections;
  "engines/inventory/engine": typeof engines_inventory_engine;
  "engines/inventory/model": typeof engines_inventory_model;
  "engines/inventory/projections": typeof engines_inventory_projections;
  "engines/posting/orchestrator": typeof engines_posting_orchestrator;
  "engines/reconciliation/model": typeof engines_reconciliation_model;
  "engines/reconciliation/rebuild": typeof engines_reconciliation_rebuild;
  "engines/shared": typeof engines_shared;
  "files/actions": typeof files_actions;
  "files/domain": typeof files_domain;
  "files/maintenance": typeof files_maintenance;
  "files/owners": typeof files_owners;
  "files/s3": typeof files_s3;
  http: typeof http;
  "iam/loginRateLimit": typeof iam_loginRateLimit;
  "iam/me": typeof iam_me;
  "iam/model": typeof iam_model;
  "iam/principal": typeof iam_principal;
  "iam/probe": typeof iam_probe;
  "iam/roles": typeof iam_roles;
  "iam/users": typeof iam_users;
  infraRestore: typeof infraRestore;
  "jobs/domain": typeof jobs_domain;
  "jobs/model": typeof jobs_model;
  "jobs/runner": typeof jobs_runner;
  "lib/actor": typeof lib_actor;
  "lib/auth": typeof lib_auth;
  "lib/authPolicy": typeof lib_authPolicy;
  "lib/budget": typeof lib_budget;
  "lib/companyScope": typeof lib_companyScope;
  "lib/dates": typeof lib_dates;
  "lib/decimal": typeof lib_decimal;
  "lib/errors": typeof lib_errors;
  "lib/idempotency": typeof lib_idempotency;
  "lib/ids": typeof lib_ids;
  "lib/invariants": typeof lib_invariants;
  "lib/mutationContext": typeof lib_mutationContext;
  "lib/pagination": typeof lib_pagination;
  "lib/permissions": typeof lib_permissions;
  "lib/queryProfiles": typeof lib_queryProfiles;
  "lib/username": typeof lib_username;
  "migration/closureManifest": typeof migration_closureManifest;
  "migration/decimalManifest": typeof migration_decimalManifest;
  "migration/engineMatrix": typeof migration_engineMatrix;
  "migration/engineQueryProfiles": typeof migration_engineQueryProfiles;
  "migration/ioManifest": typeof migration_ioManifest;
  "migration/resourceManifest": typeof migration_resourceManifest;
  "migration/tableManifest": typeof migration_tableManifest;
  "platform/audit/model": typeof platform_audit_model;
  "platform/audit/write": typeof platform_audit_write;
  "platform/numbering/catalog": typeof platform_numbering_catalog;
  "platform/numbering/defaults": typeof platform_numbering_defaults;
  "platform/numbering/model": typeof platform_numbering_model;
  "platform/numbering/service": typeof platform_numbering_service;
  "platform/printing/actions": typeof platform_printing_actions;
  "platform/printing/builders": typeof platform_printing_builders;
  "platform/printing/catalog": typeof platform_printing_catalog;
  "platform/printing/format": typeof platform_printing_format;
  "platform/printing/jobs": typeof platform_printing_jobs;
  "platform/printing/policy": typeof platform_printing_policy;
  "platform/printing/renderer": typeof platform_printing_renderer;
  "platform/printing/templates": typeof platform_printing_templates;
  "platform/printing/types": typeof platform_printing_types;
  "platform/printing/xlsx": typeof platform_printing_xlsx;
  "platform/printing/zip": typeof platform_printing_zip;
  reconciliation: typeof reconciliation;
  "resources/currencies": typeof resources_currencies;
  "resources/ioProbe": typeof resources_ioProbe;
  "resources/model": typeof resources_model;
  "resources/probe": typeof resources_probe;
  "resources/units": typeof resources_units;
  "resources/warehouseSeed": typeof resources_warehouseSeed;
  "resources/warehouses": typeof resources_warehouses;
  "setup/complete": typeof setup_complete;
  "setup/core": typeof setup_core;
  "setup/createFirstUser": typeof setup_createFirstUser;
  "setup/model": typeof setup_model;
  "setup/sample": typeof setup_sample;
  "setup/sampleAction": typeof setup_sampleAction;
  "setup/seeds": typeof setup_seeds;
  "setup/spike": typeof setup_spike;
  "setup/state": typeof setup_state;
  "setup/status": typeof setup_status;
  "test/engineProbe": typeof test_engineProbe;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
