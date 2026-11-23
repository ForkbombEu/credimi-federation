/**
 * Admin routes (only registered when FEDERATION_ADMIN_PASSWORD is set).
 * Every route except the login page needs a session; every POST except the
 * login needs the session's CSRF token. All writes go through
 * Registry.update, which validates exactly as startup does.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { checkLiveKeys, type Fetch } from "./keycheck.js";
import {
  GitHubManagedError,
  Registry,
  RegistryWriteError,
  UnknownSubordinateError,
} from "./registry.js";
import { sendPage } from "./responses.js";
import {
  AdminSessions,
  clearedSessionCookie,
  csrfTokenMatches,
  sessionCookie,
  sessionIdFromCookies,
  type AdminSession,
} from "./sessions.js";
import { SubordinateConfigError, type RegistryEntry, type Subordinate } from "./subordinates.js";
import {
  adminMessagePage,
  dashboardPage,
  deletePage,
  entryFormPage,
  isNotice,
  keyCheckPage,
  loginPage,
  type EntryFormValues,
  type Notice,
} from "./ui/admin.js";
import type { SiteInfo } from "./ui/pages.js";

export interface AdminDependencies {
  readonly registry: Registry;
  readonly sessions: AdminSessions;
  readonly site: SiteInfo;
  readonly fetch: Fetch;
}

/** Forms post to this origin only; everything else matches the public pages. */
export const ADMIN_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Large enough for several RSA-4096 JWKs plus policies; small enough to bound parsing. */
const FORM_BODY_LIMIT = 64 * 1024;

const EMPTY_FORM: EntryFormValues = {
  entityId: "",
  entityTypes: "",
  enabled: false,
  jwks: "",
  metadataPolicy: "",
  constraints: "",
};

/** Registers the admin routes on an encapsulated Fastify scope. */
export function adminRoutes(app: FastifyInstance, deps: AdminDependencies): void {
  const { registry, sessions, site } = deps;

  // Scoped to this plugin: the public routes still read no request body.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: FORM_BODY_LIMIT },
    (_request, body, done) => {
      done(null, new URLSearchParams(body as string));
    },
  );

  const page = (reply: FastifyReply, status: number, body: string): FastifyReply =>
    sendPage(reply, status, ADMIN_CSP, body);

  /** The session, or undefined after answering with a redirect or 403. */
  const authorize = (
    request: FastifyRequest,
    reply: FastifyReply,
    requireCsrf: boolean,
  ): AdminSession | undefined => {
    const session = sessions.get(sessionIdFromCookies(request.headers.cookie));
    if (session === undefined) {
      void reply.redirect("/admin/login", 303);
      return undefined;
    }
    if (requireCsrf && !csrfTokenMatches(session, formOf(request).get("csrf"))) {
      void page(
        reply,
        403,
        adminMessagePage(
          site,
          "Form expired",
          "This form was not issued for your current session. Reload the page and try again.",
          session.csrfToken,
        ),
      );
      return undefined;
    }
    return session;
  };

  const notFound = (reply: FastifyReply, session: AdminSession, subject: string): FastifyReply =>
    page(
      reply,
      404,
      adminMessagePage(
        site,
        "Not registered",
        `No subordinate ${subject} is registered. It may have been changed in another window.`,
        session.csrfToken,
      ),
    );

  /** Applies a change and answers with the outcome; `index` locates the edited entry's issues. */
  const applyChange = async (
    request: FastifyRequest,
    reply: FastifyReply,
    session: AdminSession,
    change: (entries: RegistryEntry[]) => { entries: RegistryEntry[]; index: number },
    outcome: { notice: Notice; subject: string; form?: EntryFormModelInput },
  ): Promise<FastifyReply> => {
    let index = -1;
    try {
      await registry.update((entries) => {
        const result = change(entries);
        index = result.index;
        return result.entries;
      });
    } catch (error) {
      if (error instanceof UnknownSubordinateError) {
        return notFound(reply, session, error.entityId);
      }
      const issues =
        error instanceof GitHubManagedError
          ? [error.message]
          : error instanceof SubordinateConfigError
            ? entryIssues(error.issues, index)
            : undefined;
      if (issues !== undefined) {
        return outcome.form === undefined
          ? page(
              reply,
              422,
              adminMessagePage(site, "Not saved", issues.join(" "), session.csrfToken),
            )
          : page(
              reply,
              422,
              entryFormPage(site, { ...outcome.form, issues, csrfToken: session.csrfToken }),
            );
      }
      if (error instanceof RegistryWriteError) {
        request.log.error({ err: error }, "admin change not saved");
        return page(
          reply,
          500,
          adminMessagePage(site, "Not saved", error.message, session.csrfToken),
        );
      }
      throw error;
    }
    request.log.info(
      { action: outcome.notice, entityId: outcome.subject },
      "admin changed registry",
    );
    return reply.redirect(
      `/admin?done=${outcome.notice}&sub=${encodeURIComponent(outcome.subject)}`,
      303,
    );
  };

  // --- Sign in and out ---
  app.get("/admin/login", (request, reply) => {
    if (sessions.get(sessionIdFromCookies(request.headers.cookie)) !== undefined) {
      return reply.redirect("/admin", 303);
    }
    return page(reply, 200, loginPage(site));
  });

  app.post("/admin/login", (request, reply) => {
    const result = sessions.login(formOf(request).get("password") ?? "");
    if (result.ok) {
      request.log.info("admin signed in");
      return reply.header("set-cookie", sessionCookie(result.session)).redirect("/admin", 303);
    }
    request.log.warn({ reason: result.reason }, "admin sign-in refused");
    return result.reason === "throttled"
      ? page(reply, 429, loginPage(site, "Too many failed attempts. Wait a minute and try again."))
      : page(reply, 401, loginPage(site, "The password is not correct."));
  });

  app.post("/admin/logout", (request, reply) => {
    const session = authorize(request, reply, true);
    if (session === undefined) {
      return reply;
    }
    sessions.end(session.id);
    return reply.header("set-cookie", clearedSessionCookie()).redirect("/admin/login", 303);
  });

  // --- Registry overview ---
  app.get("/admin", (request, reply) => {
    const session = authorize(request, reply, false);
    if (session === undefined) {
      return reply;
    }
    const { done, sub } = request.query as { done?: unknown; sub?: unknown };
    return page(
      reply,
      200,
      dashboardPage(site, {
        members: registry.members,
        csrfToken: session.csrfToken,
        ...(isNotice(done) && typeof sub === "string"
          ? { notice: { kind: done, subject: sub } }
          : {}),
      }),
    );
  });

  // --- Add ---
  app.get("/admin/new", (request, reply) => {
    const session = authorize(request, reply, false);
    if (session === undefined) {
      return reply;
    }
    return page(
      reply,
      200,
      entryFormPage(site, { values: EMPTY_FORM, issues: [], csrfToken: session.csrfToken }),
    );
  });

  app.post("/admin/new", async (request, reply) => {
    const session = authorize(request, reply, true);
    if (session === undefined) {
      return reply;
    }
    const values = formValuesOf(formOf(request));
    const parsed = entryFromForm(values);
    if (parsed.entry === undefined) {
      return page(
        reply,
        422,
        entryFormPage(site, { values, issues: parsed.issues, csrfToken: session.csrfToken }),
      );
    }
    const entry = parsed.entry;
    return applyChange(
      request,
      reply,
      session,
      (entries) => ({ entries: [...entries, entry], index: entries.length }),
      { notice: "added", subject: entry.entity_id, form: { values } },
    );
  });

  // --- Edit ---
  app.get("/admin/edit", (request, reply) => {
    const session = authorize(request, reply, false);
    if (session === undefined) {
      return reply;
    }
    const subordinate = findSubordinate(registry.local, subjectOf(request));
    if (subordinate === undefined) {
      return notFound(reply, session, subjectOf(request) ?? "");
    }
    return page(
      reply,
      200,
      entryFormPage(site, {
        original: subordinate.entityId,
        values: formValuesFromSubordinate(subordinate),
        issues: [],
        csrfToken: session.csrfToken,
      }),
    );
  });

  app.post("/admin/edit", async (request, reply) => {
    const session = authorize(request, reply, true);
    if (session === undefined) {
      return reply;
    }
    const original = subjectOf(request) ?? "";
    const values = formValuesOf(formOf(request));
    const parsed = entryFromForm(values);
    if (parsed.entry === undefined) {
      return page(
        reply,
        422,
        entryFormPage(site, {
          original,
          values,
          issues: parsed.issues,
          csrfToken: session.csrfToken,
        }),
      );
    }
    const entry = parsed.entry;
    return applyChange(
      request,
      reply,
      session,
      (entries) => {
        const index = indexOrThrow(entries, original);
        return { entries: entries.map((value, at) => (at === index ? entry : value)), index };
      },
      { notice: "updated", subject: entry.entity_id, form: { original, values } },
    );
  });

  // --- Enable or disable ---
  app.post("/admin/status", async (request, reply) => {
    const session = authorize(request, reply, true);
    if (session === undefined) {
      return reply;
    }
    const form = formOf(request);
    const subject = form.get("sub") ?? "";
    const enabled = form.get("enabled") === "true";
    return applyChange(
      request,
      reply,
      session,
      (entries) => {
        const index = indexOrThrow(entries, subject);
        return {
          entries: entries.map((value, at) => (at === index ? { ...value, enabled } : value)),
          index,
        };
      },
      { notice: enabled ? "enabled" : "disabled", subject },
    );
  });

  // --- Delete ---
  app.get("/admin/delete", (request, reply) => {
    const session = authorize(request, reply, false);
    if (session === undefined) {
      return reply;
    }
    const subordinate = findSubordinate(registry.local, subjectOf(request));
    if (subordinate === undefined) {
      return notFound(reply, session, subjectOf(request) ?? "");
    }
    return page(reply, 200, deletePage(site, subordinate, session.csrfToken));
  });

  app.post("/admin/delete", async (request, reply) => {
    const session = authorize(request, reply, true);
    if (session === undefined) {
      return reply;
    }
    const subject = subjectOf(request) ?? "";
    return applyChange(
      request,
      reply,
      session,
      (entries) => {
        const index = indexOrThrow(entries, subject);
        return { entries: entries.filter((_value, at) => at !== index), index };
      },
      { notice: "deleted", subject },
    );
  });

  // --- Check live keys ---
  app.get("/admin/check", async (request, reply) => {
    const session = authorize(request, reply, false);
    if (session === undefined) {
      return reply;
    }
    const subordinate = findSubordinate(
      registry.members.map((member) => member.subordinate),
      subjectOf(request),
    );
    if (subordinate === undefined) {
      return notFound(reply, session, subjectOf(request) ?? "");
    }
    const report = await checkLiveKeys(subordinate, site.entityId, deps.fetch);
    return page(reply, 200, keyCheckPage(site, subordinate, report, session.csrfToken));
  });
}

type EntryFormModelInput = { readonly original?: string; readonly values: EntryFormValues };

function formOf(request: FastifyRequest): URLSearchParams {
  return request.body instanceof URLSearchParams ? request.body : new URLSearchParams();
}

function subjectOf(request: FastifyRequest): string | undefined {
  const { sub } = request.query as { sub?: unknown };
  return typeof sub === "string" ? sub : undefined;
}

function findSubordinate(
  subordinates: readonly Subordinate[],
  subject: string | undefined,
): Subordinate | undefined {
  return subject === undefined
    ? undefined
    : subordinates.find((entry) => entry.entityId === subject);
}

function indexOrThrow(entries: readonly RegistryEntry[], subject: string): number {
  const index = entries.findIndex((entry) => entry.entity_id === subject);
  if (index === -1) {
    throw new UnknownSubordinateError(subject);
  }
  return index;
}

/**
 * Registry issues name the entry as `subordinates[i]`; on the form that is
 * just "this entry", so the prefix is dropped for the edited index.
 */
function entryIssues(issues: readonly string[], index: number): string[] {
  const prefix = `subordinates[${index}]`;
  return issues.map((issue) =>
    issue.startsWith(prefix) ? issue.slice(prefix.length).replace(/^[.:]\s*/, "") : issue,
  );
}

function formValuesOf(form: URLSearchParams): EntryFormValues {
  return {
    entityId: (form.get("entity_id") ?? "").trim(),
    entityTypes: form.get("entity_types") ?? "",
    enabled: form.get("enabled") === "on",
    jwks: form.get("jwks") ?? "",
    metadataPolicy: form.get("metadata_policy") ?? "",
    constraints: form.get("constraints") ?? "",
  };
}

function formValuesFromSubordinate(subordinate: Subordinate): EntryFormValues {
  return {
    entityId: subordinate.entityId,
    entityTypes: subordinate.entityTypes.join(" "),
    enabled: subordinate.enabled,
    jwks: JSON.stringify(subordinate.jwks, null, 2),
    metadataPolicy:
      subordinate.metadataPolicy === undefined
        ? ""
        : JSON.stringify(subordinate.metadataPolicy, null, 2),
    constraints:
      subordinate.constraints === undefined ? "" : JSON.stringify(subordinate.constraints, null, 2),
  };
}

/**
 * Turns the form text into a registry entry. Only the JSON syntax and shape
 * of each field is checked here; everything else is left to the registry
 * validation, so the form accepts exactly what the file accepts.
 */
function entryFromForm(values: EntryFormValues): {
  readonly entry?: RegistryEntry;
  readonly issues: readonly string[];
} {
  const issues: string[] = [];
  const jwks = parseJwks(values.jwks, issues);
  const metadataPolicy = parseOptionalObject(values.metadataPolicy, "Metadata policy", issues);
  const constraints = parseOptionalObject(values.constraints, "Constraints", issues);
  if (values.entityId === "") {
    issues.push("Entity Identifier is required.");
  }
  if (issues.length > 0 || jwks === undefined) {
    return { issues };
  }
  return {
    issues,
    entry: {
      entity_id: values.entityId,
      enabled: values.enabled,
      entity_types: values.entityTypes.split(/[\s,]+/).filter((type) => type !== ""),
      jwks,
      ...(metadataPolicy === undefined ? {} : { metadata_policy: metadataPolicy }),
      ...(constraints === undefined ? {} : { constraints }),
    },
  };
}

function parseJwks(text: string, issues: string[]): { keys: unknown[] } | undefined {
  if (text.trim() === "") {
    issues.push("Public federation keys are required.");
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    issues.push("Public federation keys are not valid JSON.");
    return undefined;
  }
  if (Array.isArray(value)) {
    return { keys: value as unknown[] };
  }
  if (typeof value === "object" && value !== null) {
    if ("keys" in value && Array.isArray(value.keys) && Object.keys(value).length === 1) {
      return { keys: value.keys as unknown[] };
    }
    if ("kty" in value) {
      return { keys: [value] };
    }
  }
  issues.push(
    'Public federation keys must be a JWK Set {"keys": [...]}, an array of JWKs or a single JWK.',
  );
  return undefined;
}

function parseOptionalObject(
  text: string,
  label: string,
  issues: string[],
): Record<string, unknown> | undefined {
  if (text.trim() === "") {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    issues.push(`${label} is not valid JSON.`);
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push(`${label} must be a JSON object.`);
    return undefined;
  }
  return value as Record<string, unknown>;
}
