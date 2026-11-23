//! OpenAI co-pilot (chat, key verification) — native port of the former Express `/api/ai/*` routes.
//!
//! The API key lives in the OS keychain (Secret Service / Keychain / Credential Manager),
//! never in a plaintext `.env`. `OPENAI_API_KEY` from the environment is only a fallback.

use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

const KEYRING_SERVICE: &str = "br.com.xcloud.cybermonitor";
const KEYRING_USER: &str = "openai_api_key";
const OPENAI_BASE: &str = "https://api.openai.com/v1";

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().build().expect("failed to build HTTP client"))
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn is_dummy(key: &str) -> bool {
    key.len() < 10
        || matches!(
            key,
            "MY_OPENAI_API_KEY" | "sua_chave_openai_aqui" | "your_openai_api_key_here" | "YOUR_API_KEY"
        )
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn read_stored_key() -> Option<String> {
    keyring_entry().ok()?.get_password().ok()
}

/// Resolves the key: explicit override > keychain > `OPENAI_API_KEY` env. `None` when unusable.
async fn resolve_key(override_key: Option<String>) -> Option<String> {
    let candidate = match override_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => Some(k),
        None => tauri::async_runtime::spawn_blocking(read_stored_key)
            .await
            .ok()
            .flatten()
            .or_else(|| std::env::var("OPENAI_API_KEY").ok()),
    };
    candidate.map(|k| k.trim().to_string()).filter(|k| !is_dummy(k))
}

fn model() -> String {
    env_or("OPENAI_MODEL", "gpt-4o-mini")
}

#[tauri::command]
pub async fn ai_status() -> Value {
    let configured = resolve_key(None).await.is_some();
    let model = model();
    json!({
        "enabled": configured,
        "provider": "OpenAI",
        "model": model,
        "message": if configured {
            format!("OpenAI conectado com sucesso utilizando o modelo {model}.")
        } else {
            "Chave OPENAI_API_KEY não configurada. A funcionalidade de IA generativa está desabilitada, mas todos os recursos de telemetria, rotas e testes continuam 100% operacionais.".to_string()
        },
    })
}

#[tauri::command]
pub async fn ai_verify(api_key: Option<String>) -> Value {
    let Some(key) = resolve_key(api_key).await else {
        return json!({ "valid": false, "message": "Chave não informada, incompleta ou em formato inválido." });
    };
    let resp = client()
        .get(format!("{OPENAI_BASE}/models"))
        .bearer_auth(&key)
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => json!({
            "valid": true,
            "model": model(),
            "message": "Chave autenticada e validada com sucesso na OpenAI!",
        }),
        Ok(r) => {
            let status = r.status();
            let body: Value = r.json().await.unwrap_or(Value::Null);
            let msg = body["error"]["message"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| format!("Falha ao autenticar na OpenAI (HTTP {status})."));
            json!({ "valid": false, "message": msg })
        }
        Err(e) => json!({ "valid": false, "message": format!("Falha de conexão com a OpenAI: {e}") }),
    }
}

/// Stores the key in the OS keychain. An empty key removes it.
#[tauri::command]
pub async fn ai_save_key(api_key: String) -> Result<(), String> {
    let key = api_key.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring_entry()?;
        if key.is_empty() {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        } else {
            entry.set_password(&key).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// JS-style `value ?? default` rendered as text (integral floats print without `.0`).
fn show(v: &Value, default: &str) -> String {
    match v {
        Value::Null => default.to_string(),
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
            Some(f) => format!("{f}"),
            None => n.to_string(),
        },
        other => other.to_string(),
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn build_system_prompt(context: &Value) -> String {
    let metrics = &context["metrics"];
    let verdict = &context["verdict"];
    let server = &context["serverStatus"];
    let trace = &context["traceroute"];

    let smoothed = if metrics["smoothedRttMs"].is_null() {
        show(&metrics["rttAvgMs"], "N/D")
    } else {
        show(&metrics["smoothedRttMs"], "N/D")
    };
    let medium = if truthy(&metrics["isWifi24Ghz"]) {
        "Wi-Fi 2.4 GHz (Interferência / Instabilidade)"
    } else {
        "Ethernet ou Wi-Fi 5GHz/6GHz"
    };
    let route = if truthy(&trace["isHairpinning"]) {
        "ALERTA CRÍTICO: BGP Hairpinning / Desvio internacional para os EUA (Miami/Atlanta) detectado!"
    } else {
        "Rota Nacional Direta (Cold-potato via IX.br SP AS8075)"
    };
    let good_time = if truthy(&verdict["isGoodTimeToPlay"]) { "SIM" } else { "NÃO" };

    format!(
        "Você é o BOT-X, um co-piloto e mascote robótico especialista em telemetria e infraestrutura de rede para o Xbox Cloud Gaming (xCloud) no Brasil (região Azure brazilsouth / AS8075).
Seu objetivo é analisar as métricas reais fornecidas do jogador e responder com diagnósticos precisos, conselhos práticos e dicção impecável em Português do Brasil.

DADOS DE TELEMETRIA EM TEMPO REAL:
- Latência RTT Instantânea: {rtt} ms (Média suavizada: {smoothed} ms)
- Jitter Inter-chegada (RFC 3550): {jitter} ms
- Perda de Pacotes: {loss}%
- Delta de Bufferbloat (Loaded - Idle): +{bloat} ms
- Meio Físico Local: {medium}
- Saltos TTL até Datacenter: {hops} hops
- Status da Rota BGP: {route}
- Status do Cluster Azure brazilsouth (SP): Carga {load}%, Risco de Fila: {risk}, Fila estimada: {wait} min ({qmsg}).
- Veredito Geral Atual: Rank {rank} ({headline}). É bom momento para jogar: {good_time}. Causa raiz: {root}.

DIRETRIZES DE RESPOSTA E REGRA DE OURO DA LATÊNCIA:
1. REGRA ABSOLUTA DE LATÊNCIA (PRIORIDADE MÁXIMA):
   - No Xbox Cloud Gaming a 60 FPS, a latência do jogador (RTT) é o elemento MAIS CRÍTICO da jogabilidade.
   - Se a latência estiver alta (RTT > 45ms, e especialmente > 60ms), JAMAIS diga que a situação está \"ótima\" ou \"excelente\" só porque a fila dos servidores da Microsoft está zerada!
   - Esclareça ao jogador: \"Embora os servidores da Microsoft estejam sem filas, a latência da sua internet está alta (X ms), gerando atraso e input lag nos comandos. O momento NÃO é favorável para jogos rápidos!\"
2. Seja DIRETO, CONCISO e assertivo (2 a 4 frases objetivas em Português do Brasil).
3. Isole claramente a causa:
   - Se houver BGP Hairpinning ou RTT > 120ms: falha grave de rota da operadora (ISP) desviando tráfego aos EUA.
   - Se RTT estiver entre 45ms e 80ms: latência acima da ideal; avise sobre input lag mesmo se a nuvem estiver vazia.
   - Se houver Wi-Fi 2.4GHz ou jitter elevado (> 10ms): o problema é a rede local sem fio (recomende cabo RJ45 ou Wi-Fi 5GHz).
   - Se houver delta de Bufferbloat > 40ms: o roteador doméstico está saturando filas em picos de download/upload.
   - Se a latência for baixa (< 25ms) mas houver fila na Microsoft: a internet do jogador está perfeita, porém o datacenter está em horário de pico (aguarde a alocação).
   - Se tudo estiver nominal (< 25ms RTT, jitter < 2.5ms, sem fila): elogie o Rank S e confirme sensação idêntica a console local.
4. IMPORTANTE PARA SÍNTESE DE VOZ:
   Sua resposta será lida em voz alta por um sintetizador neural com dicção feminina expressiva. Pontue o texto com riqueza (use vírgulas para pausas naturais e pontos finais bem colocados). NÃO use asteriscos, markdown, tabelas ou emojis.",
        rtt = show(&metrics["rttMs"], "N/D"),
        jitter = show(&metrics["jitterMs"], "N/D"),
        loss = show(&metrics["packetLossPct"], "0"),
        bloat = show(&metrics["bufferbloatDeltaMs"], "N/D"),
        hops = show(&metrics["ttlHops"], "5"),
        load = show(&server["serverLoadPercentage"], "40"),
        risk = show(&server["queueRisk"], "NONE"),
        wait = show(&server["estimatedWaitMinutes"], "0"),
        qmsg = show(&server["queueMessage"], ""),
        rank = show(&verdict["rank"], "A"),
        headline = show(&verdict["headline"], "Nominal"),
        root = show(&verdict["rootCauseTitle"], "Nominal"),
    )
}

#[tauri::command]
pub async fn ai_chat(message: String, context: Option<Value>, history: Option<Value>) -> Value {
    let Some(key) = resolve_key(None).await else {
        return json!({
            "enabled": false,
            "error": "OPENAI_API_KEY_NOT_CONFIGURED",
            "reply": "A inteligência artificial está desabilitada no momento porque nenhuma chave OpenAI válida foi configurada. Para ativar análises inteligentes com IA, configure sua chave no botão de configurações do app. Todas as medições de rede e diagnósticos locais continuam funcionando normalmente.",
        });
    };

    let mut messages = vec![json!({
        "role": "system",
        "content": build_system_prompt(&context.unwrap_or(Value::Null)),
    })];
    if let Some(items) = history.as_ref().and_then(|h| h.as_array()) {
        let start = items.len().saturating_sub(4);
        for h in &items[start..] {
            let (Some(sender), Some(text)) = (h["sender"].as_str(), h["text"].as_str()) else { continue };
            match sender {
                "user" => messages.push(json!({ "role": "user", "content": text })),
                "bot" => messages.push(json!({ "role": "assistant", "content": text })),
                _ => {}
            }
        }
    }
    messages.push(json!({ "role": "user", "content": message }));

    let model = model();
    let outcome: Result<String, String> = async {
        let resp = client()
            .post(format!("{OPENAI_BASE}/chat/completions"))
            .bearer_auth(&key)
            .timeout(Duration::from_secs(15))
            .json(&json!({
                "model": model,
                "messages": messages,
                "max_tokens": 300,
                "temperature": 0.7,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(body["error"]["message"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| format!("HTTP {status}")));
        }
        Ok(body["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Sem resposta gerada pelo modelo.".to_string()))
    }
    .await;

    match outcome {
        Ok(reply) => json!({ "enabled": true, "provider": "OpenAI", "model": model, "reply": reply }),
        Err(err) => json!({
            "enabled": false,
            "error": "OPENAI_API_ERROR",
            "details": err,
            "reply": format!("Houve uma instabilidade ao consultar a OpenAI ({err}). Todos os diagnósticos de rede continuam funcionando normalmente."),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn show_prints_integral_floats_like_js() {
        assert_eq!(show(&json!(12.0), "N/D"), "12");
        assert_eq!(show(&json!(12.5), "N/D"), "12.5");
        assert_eq!(show(&Value::Null, "N/D"), "N/D");
    }

    #[test]
    fn dummy_keys_are_rejected() {
        assert!(is_dummy("short"));
        assert!(is_dummy("your_openai_api_key_here"));
        assert!(!is_dummy("sk-proj-abcdefghijklmnop"));
    }

    #[test]
    fn prompt_flags_hairpinning_and_defaults() {
        let p = build_system_prompt(&json!({ "traceroute": { "isHairpinning": true } }));
        assert!(p.contains("ALERTA CRÍTICO"));
        assert!(p.contains("Latência RTT Instantânea: N/D ms"));
        assert!(p.contains("Rank A (Nominal)"));
    }
}
