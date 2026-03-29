import { Context, Schema } from 'koishi'

declare module 'koishi' {
  interface Tables {
    verifyCode: VerifyCode
  }
}

export interface VerifyCode {
  BiliCode: string
  QQNumber: string
}

export interface DbVerificationConfig {
  adminId?: string
}

export const name = 'verifier'

export interface Config {
  dbVerification?: DbVerificationConfig
}

export const Config: Schema<Config> = Schema.object({
  dbVerification: Schema.object({
    adminId: Schema.string().description('管理员用户ID，用于接收重复申请通知'),
  }).description('数据库验证配置'),
})

export function apply(ctx: Context, config: Config = {}) {
  ctx.inject(['database'], (ctx) => {
    const logger = ctx.logger('verifier')

    ctx.model.extend('verifyCode', {
      BiliCode: 'string',
      QQNumber: 'string',
    }, { primary: 'BiliCode' })

    ctx.on('guild-member-request', async (session) => {
      const userId = session.event?.user?.id ?? session.userId
      const rawContent = session.content ?? ''
      // Support both plain UID and "问题：...\n答案：<uid>" format
      const answerMatch = rawContent.match(/答案[：:]\s*(.+)$/m)
      const biliCode = (answerMatch ? answerMatch[1] : rawContent).trim()
      logger.info('received guild-member-request from %s, raw content: %j, BiliCode: %s', userId, rawContent, biliCode)

      const rows = await ctx.database.get('verifyCode', [biliCode])
      logger.info('database query for BiliCode %s returned %d row(s)', biliCode, rows.length)

      if (rows.length === 0) {
        logger.info('guild-member-request rejected: BiliCode %s not found (userId: %s)', biliCode, userId)
        return session.bot.handleGuildMemberRequest(session.messageId, false, '请回答你的B站UID')
      }

      const row = rows[0]
      if (!row.QQNumber) {
        logger.info('guild-member-request approved: BiliCode %s matched, updating QQNumber to %s', biliCode, userId)
        await ctx.database.set('verifyCode', { BiliCode: biliCode }, { QQNumber: userId })
        return session.bot.handleGuildMemberRequest(session.messageId, true)
      } else {
        logger.info('guild-member-request held: BiliCode %s already bound to QQNumber %s, requester: %s', biliCode, row.QQNumber, userId)
        const { adminId } = config.dbVerification ?? {}
        if (adminId) {
          await session.bot.sendPrivateMessage(adminId, '检测到重复用户申请入群，请介入')
        } else {
          logger.info('no adminId configured, duplicate request notification skipped')
        }
      }
    })

    ctx.on('guild-member-removed', async (session) => {
      const userId = session.event?.user?.id ?? session.userId
      if (!userId) return
      const removed = await ctx.database.remove('verifyCode', { QQNumber: userId })
      logger.info('guild-member-removed: userId %s, removed %d verifyCode record(s)', userId, removed.removed ?? 0)
    })
  })
}
