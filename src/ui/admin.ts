/**
 * Admin pages. Same shell as the public site, plus an admin bar with the
 * sign-out form. Every form carries the session's CSRF token; there is no
 * page script, so destructive actions get their own confirmation page.
 */
import type { KeyCheckReport } from "../keycheck.js";
import type { Subordinate } from "../subordinates.js";
import { html, type SafeHtml } from "./html.js";
import { layout, type SiteInfo } from "./pages.js";

/** What the add/edit form shows; the raw text the operator typed or the stored entry. */
export interface EntryFormValues {
  readonly entityId: string;
  readonly entityTypes: string;
  readonly enabled: boolean;
  readonly jwks: string;
  readonly metadataPolicy: string;
  readonly constraints: string;
}

export type Notice = "added" | "updated" | "enabled" | "disabled" | "deleted";

const NOTICE_TEXT: Readonly<Record<Notice, string>> = {
  added: "Added",
  updated: "Saved",
  enabled: "Enabled",
  disabled: "Disabled",
  deleted: "Deleted",
};

export function isNotice(value: unknown): value is Notice {
  return typeof value === "string" && Object.hasOwn(NOTICE_TEXT, value);
}

export function adminUrl(path: "edit" | "delete" | "check", subject: string): string {
  return `/admin/${path}?sub=${encodeURIComponent(subject)}`;
}

export function loginPage(site: SiteInfo, error?: string): string {
  const body = html`
    <div class="container page-content">
      <div class="card login-card">
        <p class="eyebrow">Administration</p>
        <h1 class="page-title">Sign in</h1>
        <p class="section-note">
          The admin area changes which entities this Trust Anchor vouches for.
        </p>
        ${error === undefined ? "" : errorAlert("Sign-in failed", [error])}
        <form class="admin-form" method="post" action="/admin/login">
          <div class="field">
            <label for="password">Admin password</label>
            <input
              type="password"
              id="password"
              name="password"
              autocomplete="current-password"
              required
              autofocus
            />
          </div>
          <div class="form-actions">
            <button class="btn btn-primary btn-md" type="submit">Sign in</button>
          </div>
        </form>
      </div>
    </div>
  `;
  return layout(site, { title: "Sign in", section: "admin", body, head: noIndex() });
}

export interface DashboardModel {
  readonly subordinates: readonly Subordinate[];
  readonly csrfToken: string;
  readonly notice?: { readonly kind: Notice; readonly subject: string };
}

export function dashboardPage(site: SiteInfo, model: DashboardModel): string {
  const enabled = model.subordinates.filter((entry) => entry.enabled).length;
  const body = html`
    <div class="container page-content">
      <p class="eyebrow">Administration</p>
      <h1 class="page-title">Subordinate registry</h1>
      <p class="section-note">
        ${enabled} enabled of ${model.subordinates.length} registered. Every change is validated,
        saved to the registry file and served immediately; no restart is needed.
      </p>
      ${model.notice === undefined ? "" : noticeAlert(model.notice.kind, model.notice.subject)}
      <div class="hero-actions">
        <a class="btn btn-primary btn-md" href="/admin/new">Add subordinate</a>
      </div>
      ${
        model.subordinates.length === 0
          ? html`<div class="card empty-state">
              <p><strong>No subordinate entities are registered yet.</strong></p>
              <p>Add one with its Entity Identifier and the public keys its operator sent you.</p>
            </div>`
          : html`<div class="card test-table-wrap">
              <table class="test-table stack-table">
                <thead>
                  <tr>
                    <th scope="col">Entity Identifier</th>
                    <th scope="col">Entity types</th>
                    <th scope="col">Status</th>
                    <th scope="col">Key IDs</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${model.subordinates.map((subordinate) =>
                    dashboardRow(subordinate, model.csrfToken),
                  )}
                </tbody>
              </table>
            </div>`
      }
    </div>
  `;
  return adminLayout(site, "Subordinate registry", model.csrfToken, body);
}

function dashboardRow(subordinate: Subordinate, csrfToken: string): SafeHtml {
  return html`<tr>
    <td data-label="Entity Identifier"><code class="entity-ref">${subordinate.entityId}</code></td>
    <td data-label="Entity types">
      ${
        subordinate.entityTypes.length === 0
          ? html`<span class="text-muted">—</span>`
          : subordinate.entityTypes.map(
              (type) => html`<code class="inline-code entity-type">${type}</code> `,
            )
      }
    </td>
    <td data-label="Status">
      ${
        subordinate.enabled
          ? html`<span class="status-chip status-verifier">Enabled</span>`
          : html`<span class="badge badge-neutral">Disabled</span>`
      }
    </td>
    <td data-label="Key IDs">
      ${subordinate.jwks.keys.map((key) => html`<code class="kid">${key.kid}</code> `)}
    </td>
    <td data-label="Actions">
      <div class="row-actions">
        <a href="${adminUrl("edit", subordinate.entityId)}">Edit</a>
        <a href="${adminUrl("check", subordinate.entityId)}">Check live keys</a>
        <form method="post" action="/admin/status">
          ${csrfField(csrfToken)}
          <input type="hidden" name="sub" value="${subordinate.entityId}" />
          <input type="hidden" name="enabled" value="${subordinate.enabled ? "false" : "true"}" />
          <button class="btn btn-outline btn-sm" type="submit">
            ${subordinate.enabled ? "Disable" : "Enable"}
          </button>
        </form>
        <a href="${adminUrl("delete", subordinate.entityId)}">Delete</a>
      </div>
    </td>
  </tr>`;
}

export interface EntryFormModel {
  /** Undefined when adding; the stored Entity Identifier when editing. */
  readonly original?: string;
  readonly values: EntryFormValues;
  readonly issues: readonly string[];
  readonly csrfToken: string;
}

export function entryFormPage(site: SiteInfo, model: EntryFormModel): string {
  const editing = model.original !== undefined;
  const title = editing ? "Edit subordinate" : "Add subordinate";
  const action = model.original === undefined ? "/admin/new" : adminUrl("edit", model.original);
  const { values } = model;
  const body = html`
    <div class="container page-content">
      <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/admin">Registry</a> / ${title}</nav>
      <p class="eyebrow">Administration</p>
      <h1 class="page-title">${title}</h1>
      ${
        model.original === undefined
          ? ""
          : html`<p class="entity-id"><code class="inline-code">${model.original}</code></p>`
      }
      ${
        model.issues.length === 0
          ? ""
          : errorAlert("Nothing was saved. Fix these problems and save again.", model.issues)
      }
      <form class="admin-form card" method="post" action="${action}">
        ${csrfField(model.csrfToken)}
        <div class="field">
          <label for="entity_id">Entity Identifier</label>
          <input
            type="text"
            id="entity_id"
            name="entity_id"
            value="${values.entityId}"
            required
            autocomplete="off"
            spellcheck="false"
            aria-describedby="entity_id-hint"
          />
          <p class="field-hint" id="entity_id-hint">
            An <code>https</code> URL without query or fragment, for example
            <code>https://issuer.example.org</code>.
          </p>
        </div>
        <div class="field">
          <label for="entity_types">Entity types</label>
          <input
            type="text"
            id="entity_types"
            name="entity_types"
            value="${values.entityTypes}"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="entity_types-hint"
          />
          <p class="field-hint" id="entity_types-hint">
            Separated by spaces or commas, for example <code>openid_credential_issuer</code>,
            <code>openid_credential_verifier</code>, <code>openid_wallet_provider</code>. Used for
            listing and display only.
          </p>
        </div>
        <div class="field">
          <label for="jwks">Public federation keys (JWK Set)</label>
          <textarea
            id="jwks"
            name="jwks"
            rows="12"
            required
            spellcheck="false"
            aria-describedby="jwks-hint"
          >
${values.jwks}</textarea>
          <p class="field-hint" id="jwks-hint">
            Paste the keys the subordinate's operator sent you over a trusted channel: a JWK Set
            <code>{"keys": [...]}</code>, an array of JWKs or one JWK, each with a <code>kid</code>.
            Never copy them from the subordinate's Entity Configuration; use
            <em>Check live keys</em> afterwards to compare.
          </p>
        </div>
        <div class="field">
          <label for="metadata_policy">Metadata policy (optional)</label>
          <textarea
            id="metadata_policy"
            name="metadata_policy"
            rows="4"
            spellcheck="false"
            aria-describedby="metadata_policy-hint"
          >
${values.metadataPolicy}</textarea>
          <p class="field-hint" id="metadata_policy-hint">
            A JSON object of OpenID Federation 1.0 §6.1 operators, or empty.
          </p>
        </div>
        <div class="field">
          <label for="constraints">Constraints (optional)</label>
          <textarea
            id="constraints"
            name="constraints"
            rows="3"
            spellcheck="false"
            aria-describedby="constraints-hint"
          >
${values.constraints}</textarea>
          <p class="field-hint" id="constraints-hint">
            A JSON object with <code>max_path_length</code>, <code>naming_constraints</code> or
            <code>allowed_entity_types</code>, or empty.
          </p>
        </div>
        <div class="field field-check">
          <input
            type="checkbox"
            id="enabled"
            name="enabled"
            value="on"
            ${values.enabled ? html`checked` : ""}
          />
          <label for="enabled">
            Enabled: publish a Subordinate Statement and list this entity. Enable only after
            <em>Check live keys</em> confirms the pinned keys.
          </label>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary btn-md" type="submit">
            ${editing ? "Save changes" : "Add subordinate"}
          </button>
          <a class="btn btn-outline btn-md" href="/admin">Cancel</a>
        </div>
      </form>
    </div>
  `;
  return adminLayout(site, title, model.csrfToken, body);
}

export function deletePage(site: SiteInfo, subordinate: Subordinate, csrfToken: string): string {
  const body = html`
    <div class="container page-content">
      <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/admin">Registry</a> / Delete</nav>
      <p class="eyebrow">Administration</p>
      <h1 class="page-title">Delete subordinate</h1>
      <p class="entity-id"><code class="inline-code">${subordinate.entityId}</code></p>
      <p class="section-note">
        The Trust Anchor stops publishing a Subordinate Statement for this entity at once, and its
        pinned keys are removed from the registry. To stop vouching for it while keeping the entry,
        disable it instead.
      </p>
      <form class="form-actions" method="post" action="${adminUrl("delete", subordinate.entityId)}">
        ${csrfField(csrfToken)}
        <button class="btn btn-destructive btn-md" type="submit">Delete subordinate</button>
        <a class="btn btn-outline btn-md" href="/admin">Cancel</a>
      </form>
    </div>
  `;
  return adminLayout(site, "Delete subordinate", csrfToken, body);
}

export function keyCheckPage(
  site: SiteInfo,
  subordinate: Subordinate,
  report: KeyCheckReport,
  csrfToken: string,
): string {
  const passed = report.checks.every((check) => check.ok);
  const body = html`
    <div class="container page-content">
      <nav class="breadcrumb" aria-label="Breadcrumb">
        <a href="/admin">Registry</a> / Check live keys
      </nav>
      <p class="eyebrow">Administration</p>
      <h1 class="page-title">Check live keys</h1>
      <p class="entity-id"><code class="inline-code">${subordinate.entityId}</code></p>
      <p class="section-note">
        Fetched <code>${report.url}</code> just now and compared it with the keys pinned in the
        registry. Nothing was changed. ${passed ? "All checks passed." : ""}
      </p>
      <div class="card test-table-wrap">
        <table class="test-table stack-table">
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Result</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            ${report.checks.map(
              (check) =>
                html`<tr>
                  <td data-label="Check">${check.label}</td>
                  <td data-label="Result">
                    ${
                      check.ok
                        ? html`<span class="status-chip status-verifier">Pass</span>`
                        : html`<span class="status-chip status-fail">Fail</span>`
                    }
                  </td>
                  <td data-label="Detail">${check.detail}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <div class="hero-actions">
        <a class="btn btn-outline btn-md" href="${adminUrl("check", subordinate.entityId)}"
          >Check again</a
        >
        <a class="btn btn-outline btn-md" href="${adminUrl("edit", subordinate.entityId)}"
          >Edit subordinate</a
        >
      </div>
    </div>
  `;
  return adminLayout(site, "Check live keys", csrfToken, body);
}

/** Error page for an admin request; shown with the sign-out bar when signed in. */
export function adminMessagePage(
  site: SiteInfo,
  title: string,
  message: string,
  csrfToken?: string,
): string {
  const body = html`
    <div class="container page-content">
      <p class="eyebrow">Administration</p>
      <h1 class="page-title">${title}</h1>
      <p>${message}</p>
      <p class="hero-actions">
        <a class="btn btn-outline btn-md" href="/admin">Back to the registry</a>
      </p>
    </div>
  `;
  return csrfToken === undefined
    ? layout(site, { title, section: "admin", body, head: noIndex() })
    : adminLayout(site, title, csrfToken, body);
}

function adminLayout(site: SiteInfo, title: string, csrfToken: string, body: SafeHtml): string {
  const withBar = html`
    <div class="admin-bar">
      <div class="admin-bar-inner">
        <a class="admin-bar-title" href="/admin">Admin · Subordinate registry</a>
        <form method="post" action="/admin/logout">
          ${csrfField(csrfToken)}
          <button class="btn btn-ghost btn-sm" type="submit">Sign out</button>
        </form>
      </div>
    </div>
    ${body}
  `;
  return layout(site, { title, section: "admin", body: withBar, head: noIndex() });
}

function csrfField(token: string): SafeHtml {
  return html`<input type="hidden" name="csrf" value="${token}" />`;
}

function noIndex(): SafeHtml {
  return html`<meta name="robots" content="noindex, nofollow" />`;
}

function noticeAlert(kind: Notice, subject: string): SafeHtml {
  const live =
    kind === "deleted"
      ? "It is no longer served."
      : kind === "disabled"
        ? "Its Subordinate Statement is no longer served."
        : "The change is live.";
  return html`<div class="alert alert-success" role="status">
    <svg
      class="alert-icon"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 7 17l-5-5" />
      <path d="m22 10-7.5 7.5L13 16" />
    </svg>
    <div>
      <p class="alert-title">${NOTICE_TEXT[kind]} <code>${subject}</code></p>
      <p>${live}</p>
    </div>
  </div>`;
}

function errorAlert(title: string, issues: readonly string[]): SafeHtml {
  return html`<div class="alert alert-destructive" role="alert">
    <svg
      class="alert-icon"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
    <div>
      <p class="alert-title">${title}</p>
      <ul class="issue-list">
        ${issues.map((issue) => html`<li>${issue}</li>`)}
      </ul>
    </div>
  </div>`;
}
