/** Shared HTML response headers for the public and admin pages. */
import type { FastifyReply } from "fastify";

export function sendPage(
  reply: FastifyReply,
  status: number,
  csp: string,
  body: string,
): FastifyReply {
  return reply
    .code(status)
    .header("content-security-policy", csp)
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("x-frame-options", "DENY")
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(body);
}
