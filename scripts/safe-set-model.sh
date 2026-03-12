#!/bin/bash
# safe-openclaw: 配置模型 API Key
# 流程: 检查密码 → 选择 provider → 输入 base URL & API key → 连接测试 → 写入配置 → 加密
# 支持: bash safe-set-model.sh 或 curl ... | bash
set -euo pipefail

# ── 颜色 ─────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}ℹ${NC} $*"; }
ok()    { echo -e "${GREEN}✔${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
err()   { echo -e "${RED}✘${NC} $*"; }

# 兼容 curl | bash：所有 read 从 /dev/tty 读取
tty_read()    { read "$@" </dev/tty; }
tty_read_s()  { read -s "$@" </dev/tty; }

# ── 定位配置文件 ──────────────────────────────────────────────────────────────
CONFIG_DIR="${OPENCLAW_HOME:-$HOME/.openclaw}"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"

if [ ! -f "$CONFIG_FILE" ]; then
  err "配置文件不存在: $CONFIG_FILE"
  info "请先运行 openclaw doctor 初始化配置。"
  exit 1
fi

# ── 检查密码 hash ─────────────────────────────────────────────────────────────
check_password_hash() {
  local pw
  pw=$(node -e "
    const fs = require('fs');
    try {
      const JSON5 = require('json5');
      const cfg = JSON5.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
      console.log(cfg?.gateway?.auth?.password || '');
    } catch {
      const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
      console.log(cfg?.gateway?.auth?.password || '');
    }
  " 2>/dev/null || echo "")
  echo "$pw"
}

PASSWORD_HASH=$(check_password_hash)
if [ -z "$PASSWORD_HASH" ] || [[ ! "$PASSWORD_HASH" == sha256:* ]]; then
  err "未检测到密码 hash。"
  info "请先设置密码:"
  echo ""
  echo "  openclaw set-password"
  echo ""
  exit 1
fi

ok "已检测到密码 hash。"
echo ""

# ── Provider 列表（用索引数组，兼容 bash 3） ─────────────────────────────────
#           name         env_var                  default_url
PROVIDERS=(
  "anthropic    ANTHROPIC_API_KEY        https://api.anthropic.com"
  "openai       OPENAI_API_KEY           https://api.openai.com/v1"
  "google       GEMINI_API_KEY           https://generativelanguage.googleapis.com"
  "openrouter   OPENROUTER_API_KEY       https://openrouter.ai/api/v1"
  "opencode     OPENCODE_API_KEY         https://opencode.ai/zen/v1"
  "mistral      MISTRAL_API_KEY          https://api.mistral.ai/v1"
  "xai          XAI_API_KEY              https://api.x.ai/v1"
  "together     TOGETHER_API_KEY         https://api.together.xyz/v1"
  "deepseek     OPENAI_API_KEY           https://api.deepseek.com/v1"
  "qwen         QWEN_PORTAL_API_KEY      https://dashscope.aliyuncs.com/compatible-mode/v1"
)

echo -e "${BOLD}选择 Provider:${NC}"
echo ""
for i in "${!PROVIDERS[@]}"; do
  name=$(echo "${PROVIDERS[$i]}" | awk '{print $1}')
  printf "  %d) %s\n" $((i + 1)) "$name"
done
echo ""
tty_read -rp "输入编号 [1-${#PROVIDERS[@]}]: " choice

if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "${#PROVIDERS[@]}" ]; then
  err "无效选择。"
  exit 1
fi

selected="${PROVIDERS[$((choice - 1))]}"
PROVIDER=$(echo "$selected" | awk '{print $1}')
ENV_VAR=$(echo "$selected" | awk '{print $2}')
DEFAULT_URL=$(echo "$selected" | awk '{print $3}')

ok "已选择: $PROVIDER"
echo ""

# ── 输入 Base URL ────────────────────────────────────────────────────────────
tty_read -rp "Base URL [${DEFAULT_URL}]: " BASE_URL
BASE_URL="${BASE_URL:-$DEFAULT_URL}"
# 去掉末尾斜杠
BASE_URL="${BASE_URL%/}"
echo ""

# ── 输入 API Key ─────────────────────────────────────────────────────────────
tty_read_s -rp "API Key: " API_KEY
echo ""
echo ""

if [ -z "$API_KEY" ]; then
  err "API Key 不能为空。"
  exit 1
fi

# ── 输入模型名称 ──────────────────────────────────────────────────────────────
tty_read -rp "模型名称 (如 claude-sonnet-4-20250514, qwen3.5-plus): " MODEL_NAME
if [ -z "$MODEL_NAME" ]; then
  err "模型名称不能为空。"
  exit 1
fi
echo ""

# ── 连接测试（发送 hello 验证） ───────────────────────────────────────────────
info "正在测试连接（发送 hello）..."

RESPONSE_FILE=$(mktemp)
trap 'rm -f "$RESPONSE_FILE"' EXIT

if [ "$PROVIDER" = "anthropic" ]; then
  HTTP_CODE=$(curl -s -w "%{http_code}" -o "$RESPONSE_FILE" \
    --max-time 30 \
    -H "x-api-key: $API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "{\"model\":\"$MODEL_NAME\",\"max_tokens\":100,\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}" \
    "${BASE_URL}/v1/messages" 2>/dev/null || echo "000")
elif [ "$PROVIDER" = "google" ]; then
  HTTP_CODE=$(curl -s -w "%{http_code}" -o "$RESPONSE_FILE" \
    --max-time 30 \
    -H "content-type: application/json" \
    -d "{\"contents\":[{\"parts\":[{\"text\":\"hello\"}]}]}" \
    "${BASE_URL}/v1beta/models/${MODEL_NAME}:generateContent?key=${API_KEY}" 2>/dev/null || echo "000")
else
  # OpenAI 兼容 (openai, openrouter, qwen, deepseek, mistral, xai, together, opencode)
  HTTP_CODE=$(curl -s -w "%{http_code}" -o "$RESPONSE_FILE" \
    --max-time 30 \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL_NAME\",\"max_tokens\":100,\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}" \
    "${BASE_URL}/chat/completions" 2>/dev/null || echo "000")
fi

RESPONSE_BODY=$(cat "$RESPONSE_FILE" 2>/dev/null || echo "")

if [ "$HTTP_CODE" = "000" ]; then
  err "连接失败（网络不可达或超时）。"
  tty_read -rp "是否仍要保存配置？[y/N]: " force_save
  [[ "$force_save" =~ ^[Yy] ]] || exit 1
elif [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
  err "认证失败 (HTTP $HTTP_CODE)，请检查 API Key。"
  echo "$RESPONSE_BODY" | head -3
  tty_read -rp "是否仍要保存配置？[y/N]: " force_save
  [[ "$force_save" =~ ^[Yy] ]] || exit 1
elif [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  # 提取模型回复内容
  REPLY_TEXT=$(node -e "
    try {
      const r = JSON.parse(process.argv[1]);
      // OpenAI 兼容格式
      if (r.choices?.[0]?.message?.content) {
        console.log(r.choices[0].message.content);
      // Anthropic 格式
      } else if (r.content?.[0]?.text) {
        console.log(r.content[0].text);
      // Google 格式
      } else if (r.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.log(r.candidates[0].content.parts[0].text);
      } else {
        console.log('[无法解析回复]');
        console.log(JSON.stringify(r).slice(0, 200));
      }
    } catch { console.log('[JSON 解析失败]'); }
  " "$RESPONSE_BODY" 2>/dev/null || echo "[解析失败]")
  ok "连接测试成功 (HTTP $HTTP_CODE)"
  echo -e "  ${CYAN}模型回复:${NC} $REPLY_TEXT"
else
  err "请求失败 (HTTP $HTTP_CODE)"
  echo "$RESPONSE_BODY" | head -3
  tty_read -rp "是否仍要保存配置？[y/N]: " force_save
  [[ "$force_save" =~ ^[Yy] ]] || exit 1
fi

echo ""

# ── 写入配置并加密 ────────────────────────────────────────────────────────────
info "正在写入并加密配置..."

# 用 node 直接读取已有的密码 hash 做 AES-256-GCM 加密后写入
node -e "
const fs = require('fs');
const crypto = require('crypto');
const configPath = '$CONFIG_FILE';

let cfg;
try {
  const JSON5 = require('json5');
  cfg = JSON5.parse(fs.readFileSync(configPath, 'utf8'));
} catch {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// 取已有的密码 hash
const storedPw = cfg?.gateway?.auth?.password || '';
if (!storedPw.startsWith('sha256:')) {
  console.error('ERROR: 密码 hash 不存在或格式不对');
  process.exit(1);
}
const keyHex = storedPw.slice('sha256:'.length);

// AES-256-GCM 加密
function encrypt(plaintext, hex) {
  const key = Buffer.from(hex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, tag, encrypted]);
  return 'enc:v1:' + combined.toString('base64');
}

// 确保 env 段存在
if (!cfg.env) cfg.env = {};

// 写入加密后的 API key
cfg.env['$ENV_VAR'] = encrypt('$API_KEY', keyHex);

// 如果 base URL 不是默认值，也写入（base URL 不含敏感信息，明文即可）
const defaultUrl = '$DEFAULT_URL';
const baseUrl = '$BASE_URL';
if (baseUrl !== defaultUrl) {
  const baseUrlVarMap = {
    anthropic: 'ANTHROPIC_BASE_URL',
    openai: 'OPENAI_BASE_URL',
    google: 'GOOGLE_BASE_URL',
    openrouter: 'OPENROUTER_BASE_URL',
    opencode: 'OPENCODE_BASE_URL',
    mistral: 'MISTRAL_BASE_URL',
    xai: 'XAI_BASE_URL',
    together: 'TOGETHER_BASE_URL',
    deepseek: 'OPENAI_BASE_URL',
    qwen: 'QWEN_BASE_URL',
  };
  const baseUrlVar = baseUrlVarMap['$PROVIDER'];
  if (baseUrlVar) {
    cfg.env[baseUrlVar] = baseUrl;
  }
}

// 写入 models.providers 配置，让 gateway 知道用哪个 provider
const provider = '$PROVIDER';
const modelName = '$MODEL_NAME';

// 确定 API 类型
function resolveApi(prov, model) {
  if (prov === 'anthropic') return 'anthropic-messages';
  if (prov === 'google') return 'google-generative-ai';
  if (model.startsWith('claude-')) return 'anthropic-messages';
  if (model.startsWith('gemini-')) return 'google-generative-ai';
  return 'openai-completions';
}

if (!cfg.models) cfg.models = {};
if (!cfg.models.providers) cfg.models.providers = {};

cfg.models.providers[provider] = {
  baseUrl: baseUrl,
  apiKey: '\${$ENV_VAR}',
  api: resolveApi(provider, modelName),
  models: [{
    id: modelName,
    name: modelName,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  }],
};

// 设置默认 agent 使用该 provider 和模型
if (!cfg.agents) cfg.agents = {};
if (!cfg.agents.defaults) cfg.agents.defaults = {};
cfg.agents.defaults.model = provider + '/' + modelName;

fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
" 2>&1

if [ $? -ne 0 ]; then
  err "写入配置失败。"
  exit 1
fi

echo ""
ok "配置完成！"
ok "$ENV_VAR 已加密写入 (AES-256-GCM)"
info "Provider: $PROVIDER"
info "Model: $MODEL_NAME"
if [ "$BASE_URL" != "$DEFAULT_URL" ]; then
  info "Base URL: $BASE_URL"
fi
echo ""
info "请重启 gateway 使配置生效:"
echo ""
echo "  openclaw gateway stop && openclaw gateway run"
echo ""
