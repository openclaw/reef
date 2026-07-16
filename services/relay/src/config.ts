import { fileURLToPath } from "node:url";

export interface RelayNodeConfig {
  port: number;
  databaseUrl: string;
  publicOrigin: string;
  emailFrom: string;
  developmentMode: boolean;
  trustProxyHeaders: boolean;
  staticDirectory: string;
  canonicalSiteHost: string;
  redirectHosts: ReadonlySet<string>;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayNodeConfig {
  const databaseUrl = required(env, "DATABASE_URL");
  const publicOrigin = required(env, "PUBLIC_ORIGIN").replace(/\/$/, "");
  const origin = new URL(publicOrigin);
  const developmentMode = env.DEV_MODE === "1";
  const smtpHost = env.SMTP_HOST;
  if (!developmentMode && !smtpHost) throw new Error("SMTP_HOST is required unless DEV_MODE=1");
  const smtp = smtpHost ? {
    host: smtpHost,
    port: integer(env.SMTP_PORT ?? "587", "SMTP_PORT"),
    secure: env.SMTP_SECURE === "1",
    ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
    ...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
  } : undefined;
  return {
    port: integer(env.PORT ?? "8080", "PORT"),
    databaseUrl,
    publicOrigin,
    emailFrom: env.EMAIL_FROM ?? "hello@reefwire.ai",
    developmentMode,
    trustProxyHeaders: env.TRUST_PROXY_HEADERS === "1",
    staticDirectory: env.STATIC_DIR ?? fileURLToPath(new URL("../../../workers/relay/public", import.meta.url)),
    canonicalSiteHost: env.CANONICAL_SITE_HOST ?? origin.hostname,
    redirectHosts: new Set((env.SITE_REDIRECT_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean)),
    ...(smtp ? { smtp } : {}),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} must be a valid port`);
  return parsed;
}
