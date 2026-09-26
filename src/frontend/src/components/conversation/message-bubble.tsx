import { memo } from "react"
import { motion } from "framer-motion"
import { Streamdown } from "streamdown"
import { cjk } from "@streamdown/cjk"

import { OpenCodeStyleCodeBlock } from "../OpenCodeBlock"

// 流式消息 markdown 渲染（含 shiki 代码高亮 — OpenCode 风格代码卡片化）
const streamdownPlugins = { cjk }

/**
 * 用户消息内嵌图片的两种来源：
 * - `/data/chat-images/...` 服务端落盘路径（后端保存用户消息时写入 content）
 * - `data:image/...;base64,...` 乐观本地预览
 */
const IMAGE_SOURCE = "data:image\\/[^;]+;base64[^)]+|\\/data\\/chat-images\\/[^)]+"

function imageMarkdownPattern(): RegExp {
  return new RegExp(`!\\[image\\]\\((${IMAGE_SOURCE})\\)`, "g")
}

/** 从消息正文中提取内嵌图片地址（保持出现顺序） */
export function extractImageSources(content: string): readonly string[] {
  const sources: string[] = []
  for (const match of content.matchAll(imageMarkdownPattern())) {
    const source = match[1]
    if (source) sources.push(source)
  }
  return sources
}

/** 去掉图片 markdown，只留正文（图片由气泡单独渲染为缩略图） */
export function stripImageMarkdown(content: string): string {
  return content.replace(imageMarkdownPattern(), "").trim()
}

export interface ConversationMessage {
  readonly id: string
  readonly role: string
  readonly content: string
  readonly createdAt?: string
}

export interface ConversationMessageBubbleProps {
  readonly message: ConversationMessage
  readonly index: number
}

/**
 * 共享会话气泡 —— Chat 与 CodingHome 同一实现：
 * 用户消息右对齐气泡（内嵌图片缩略图 + 正文），助手消息纯 markdown 无气泡。
 * React.memo：流式更新时仅重渲染正在变化的助手消息。
 */
export const ConversationMessageBubble = memo(function ConversationMessageBubble({
  message,
  index,
}: ConversationMessageBubbleProps) {
  // tool 消息由 Activity Stream 统一展示
  if (message.role === "tool") return null
  const content = message.content ?? ""
  // 助手消息无内容时不渲染（流式首帧为空）
  if (message.role === "assistant" && !content.trim()) return null

  const isUser = message.role === "user"
  const images = isUser ? extractImageSources(content) : []
  const body = isUser ? stripImageMarkdown(content) : content
  const time = message.createdAt
    ? new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.3) }}
      style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 16 }}
    >
      <div style={{ maxWidth: "78%" }}>
        {isUser ? (
          <div
            style={{
              padding: "10px 16px",
              borderRadius: 22,
              background: "var(--color-accent)",
              color: "var(--on-accent)",
              fontSize: 16,
              lineHeight: 1.5,
              overflowWrap: "anywhere",
              whiteSpace: "pre-wrap",
            }}
          >
            {images.map((source) => (
              <img
                key={source}
                src={source}
                alt=""
                style={{ maxWidth: "100%", maxHeight: 300, borderRadius: 8, marginBottom: 8, display: "block" }}
              />
            ))}
            <div className="prose-md-body" style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
              <Streamdown plugins={streamdownPlugins} components={{ pre: OpenCodeStyleCodeBlock }}>
                {body}
              </Streamdown>
            </div>
            {time ? (
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 4, textAlign: "right" }}>
                {time}
              </div>
            ) : null}
          </div>
        ) : (
          // 粒度 live region（P1-058）：assistant 输出逐条播报，避免屏幕阅读器在流式更新时重读整个对话。
          <div className="prose-md-body" style={{ overflowWrap: "anywhere" }} aria-live="polite" aria-atomic="true">
            <Streamdown plugins={streamdownPlugins} components={{ pre: OpenCodeStyleCodeBlock }}>
              {body}
            </Streamdown>
            {time ? (
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{time}</div>
            ) : null}
          </div>
        )}
      </div>
    </motion.div>
  )
})
