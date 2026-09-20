import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AvitoAdsConfig } from "../types.js";
import { fail, ok, READ_ONLY } from "./util.js";

/**
 * The self-diagnosis tool.
 *
 * Every other tool here needs credentials, so an install with a wrong variable
 * can only report "this call failed" over and over — which is exactly what the
 * telemetry showed: one install spawning the server 931 times in two weeks with
 * a malformed account id and never making a single successful call. There was
 * no way for the model to answer "what exactly is wrong with my setup?" without
 * guessing. This tool answers it from local state alone: which variables are
 * present, which one is malformed and what the fix is.
 *
 * Values never leave the machine: the account id is the only one echoed (it is
 * not a secret and seeing it is the whole point of checking it), the client id
 * and secret are reported as present/absent only.
 */
export function registerSetupTools(
  server: McpServer,
  config: AvitoAdsConfig,
  problem?: { message: string; reason: string },
): void {
  server.registerTool(
    "auth_status",
    {
      title: "Статус подключения к Авито Рекламе",
      annotations: READ_ONLY,
      description:
        "Показывает, готов ли сервер работать: заданы ли AVITO_ADS_CLIENT_ID, AVITO_ADS_CLIENT_SECRET и " +
        "AVITO_ADS_ACCOUNT_ID, нет ли среди них испорченного значения, какое окружение выбрано " +
        "(production или sandbox) и какой адрес API используется. Ничего не отправляет в сеть и не " +
        "возвращает ни client secret, ни токен. Вызовите это первым, если инструменты отвечают, что " +
        "учётных данных нет или что аккаунт не найден: ответ называет конкретную переменную и что с " +
        "ней не так, вместо повторения одной и той же ошибки на каждом вызове.",
      inputSchema: {},
    },
    async () => {
      try {
        const missing = [
          config.clientId ? undefined : "AVITO_ADS_CLIENT_ID",
          config.clientSecret ? undefined : "AVITO_ADS_CLIENT_SECRET",
          config.accountId ? undefined : "AVITO_ADS_ACCOUNT_ID",
        ].filter((name): name is string => Boolean(name));

        return ok({
          ready: missing.length === 0 && !problem,
          // Only the presence of the secrets is reported; the account id is not
          // a secret, and seeing it is how a wrong cabinet gets noticed.
          clientId: config.clientId ? "задан" : "не задан",
          clientSecret: config.clientSecret ? "задан" : "не задан",
          accountId: config.accountId ?? null,
          environment: config.environment,
          apiBase: config.apiBase,
          missing,
          problem: problem
            ? { reason: problem.reason, message: problem.message }
            : undefined,
          note: problem
            ? "Значение одной из переменных испорчено — смотрите problem.message. Исправьте её в конфигурации MCP-клиента и перезапустите сервер: переменные читаются только при старте."
            : missing.length
              ? `Не заданы переменные: ${missing.join(", ")}. Задайте их в конфигурации MCP-клиента и перезапустите сервер — они читаются только при старте.`
              : "Учётные данные на месте. Если вызовы всё равно отказывают, проверьте, что ключ выдан именно для этого рекламного аккаунта: пустой 403 без текста означает чужой AVITO_ADS_ACCOUNT_ID, а 401 — неверные client id/secret.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
