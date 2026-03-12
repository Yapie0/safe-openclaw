# safe-openclaw

> **[openclaw](https://github.com/openclaw/openclaw) 的安全增强版。**
> openclaw 默认没有任何认证机制，API 密钥以明文存储——把它部署到服务器上，任何人发现你的地址就能完全控制你的 AI 网关，拿走你所有的 API 密钥，造成大额账单。
> safe-openclaw 在 openclaw 之上构建了完整的安全架构：强制认证网关、AES-256 密钥加密、会话管理、敏感信息过滤、密码保护访问——一键替换，零迁移成本。

中文 | **[English](README.en.md)**

<p align="center">
  <a href="https://github.com/Yapie0/safe-openclaw/releases"><img src="https://img.shields.io/github/v/release/Yapie0/safe-openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://www.npmjs.com/package/safe-openclaw"><img src="https://img.shields.io/npm/v/safe-openclaw?style=for-the-badge&color=cb3837" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

## 已经在用 openclaw？一条命令完成安全升级

不需要卸载任何东西。安装脚本会自动检测你已有的 openclaw，原地替换并应用所有安全补丁，重启网关——你的配置、会话、频道全部保留：

```bash
curl -fsSL https://raw.githubusercontent.com/Yapie0/safe-openclaw/main/install.sh | bash
```

安装脚本做了什么：
1. 将 safe-openclaw 作为 openclaw 的替代安装（`npm install -g openclaw@npm:safe-openclaw`）
2. 停止正在运行的网关
3. 重启网关，安全补丁自动生效
4. 首次使用会引导你在浏览器设置密码 `http://localhost:18789/setup`
5. 开发者也可以在终端直接设置密码：`openclaw set-password`

升级后，`openclaw` 命令就完成了一次安全升级。你的配置和频道完全不受影响。

## 全新安装

运行环境：**Node >= 22**

```bash
npm install -g safe-openclaw

# 方式一：开发者——先在终端设置密码，再启动
openclaw set-password
openclaw gateway run

# 方式二：普通用户——启动网关后在浏览器设置密码
openclaw gateway run
# 首次访问 http://localhost:18789 会自动跳转到密码设置页面
```

安装后 `openclaw` 和 `safe-openclaw` 两个命令都可以使用。

## 和 openclaw 有什么不同

| 功能 | openclaw | safe-openclaw |
|---|---|---|
| 首次访问 | 无需密码 | 必须先设置密码才能使用 |
| 密码存储 | 明文 token | SHA-256 哈希加盐存储 |
| API 密钥存储 | 明文存储在配置文件 | AES-256-GCM 加密，密钥由密码派生 |
| 密码强度 | 无要求 | 至少 8 位，包含大小写字母和数字 |
| 浏览器登录 | URL/localStorage 中的 token | 密码 + 签名会话令牌（3 天过期，HttpOnly Cookie） |
| 未设置时的远程访问 | 允许 | 拒绝（403） |
| 密码重置 | 无专用流程 | Web 界面 + 命令行（仅限本机） |
| 聊天中的密钥泄露 | 无保护 | 自动过滤敏感信息 |

## 安全补丁详情

### 1. 强制密码认证网关（解决公网裸奔问题）

openclaw 首次运行时生成一个随机 token，但从不强制用户设置密码。safe-openclaw 添加了服务端 HTTP 认证网关，在请求到达网关之前拦截**所有**请求。在密码设置完成之前，网关完全锁定（远程请求返回 403）。

- 首次访问自动跳转到 `/setup`（仅限本机访问）
- 未认证的浏览器请求展示登录页面
- 未携带有效 token 的 API 请求返回 401
- WebSocket 连接同样受会话令牌保护

### 2. 密码哈希 + API 密钥加密

openclaw 将认证 token 和所有大模型 API 密钥以**明文**存储在 `~/.openclaw/openclaw.json` 中。

safe-openclaw：
- 使用 **SHA-256** 对密码进行哈希加盐存储
- 使用 **AES-256-GCM** 加密所有大模型 API 密钥，加密密钥由密码派生
- 修改密码时自动重新加密所有密钥

### 3. 聊天消息敏感信息过滤

双重防护：即使 API 密钥已加密存储，safe-openclaw 仍会扫描所有发出的消息，匹配已知的敏感信息模式并替换为 `**********`，防止任何形式的密钥泄露。在最极端的情况下，即使攻击者绕过了所有防护，拿到的也只是加密后的密文，而非明文密钥。

### 4. 密码强度要求

所有密码设置/重置操作强制要求：至少 8 个字符，包含大写字母、小写字母和数字。

### 5. 敏感接口仅限本机访问

`/setup`、`/reset-password` 和 `/api/safe/reset-password` 通过检查请求来源的 socket 地址来验证是否来自本机，非本机请求返回 403。

### 6. 修改密码后自动重启

通过 Web 界面修改密码后，网关会检测到配置变更并自动触发重启以应用新的加密密钥。重置页面包含"验证并继续"按钮，会自动轮询直到网关恢复在线。

## 从 openclaw 迁移

你现有的 `~/.openclaw/` 配置、会话和频道会自动保留。

```bash
openclaw migrate --check
openclaw migrate --set-password 'YourStr0ngPass!'
```

## 忘记密码

密码重置仅限本机操作：

```bash
openclaw set-password
```

或者在网关所在机器的浏览器中访问 `http://localhost:18789/reset-password`。

重置后网关会自动重启。如果没有自动重启，请手动执行：

```bash
openclaw gateway stop && openclaw gateway run
```

## 从源码构建

```bash
git clone https://github.com/Yapie0/safe-openclaw.git
cd safe-openclaw

pnpm install
pnpm build

pnpm openclaw gateway run
```

## 其他功能

openclaw 的所有功能（频道、技能、代理、工具、应用）完全正常使用。详见 [openclaw 文档](https://docs.openclaw.ai)。

## 许可证

[MIT](LICENSE)
