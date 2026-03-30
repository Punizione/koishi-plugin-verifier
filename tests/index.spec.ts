import { expect, use } from 'chai'
import { App, Element, sleep, Session } from 'koishi'
import shape from 'chai-shape'
import mock, { DEFAULT_SELF_ID } from '@koishijs/plugin-mock'
import memory from '@koishijs/plugin-database-memory'
import * as jest from 'jest-mock'
import * as verifier from '../src'

use(shape)

function receive(app: App, session: Partial<Session>) {
  app.mock.receive(session)
  return sleep(0)
}

const receiveGroupMemberRequestWithContent = (app: App, userId: string, content: string, guildId = '10000') => receive(app, {
  platform: 'mock',
  selfId: DEFAULT_SELF_ID,
  type: 'guild-member-request',
  guild: { id: guildId },
  message: { id: 'flag', elements: Element.parse(content) },
  user: { id: userId },
})

const receiveGroupMemberRemoved = (app: App, userId: string, guildId = '10000') => receive(app, {
  platform: 'mock',
  selfId: DEFAULT_SELF_ID,
  type: 'guild-member-removed',
  guild: { id: guildId },
  user: { id: userId },
})

describe('koishi-plugin-verifier db verification', () => {
  async function setupWithDb(options: verifier.Config, initialData: verifier.VerifyCode[] = []) {
    const app = new App()
    app.plugin(mock)
    app.plugin(memory)
    app.plugin(verifier, options)
    await app.start()
    await app.database.prepared()
    for (const row of initialData) {
      await app.database.create('verifyCode', row)
    }
    const handleGuildMemberRequest = app.bots[0].handleGuildMemberRequest = jest.fn(async () => {})
    const sendPrivateMessage = app.bots[0].sendPrivateMessage = jest.fn(async () => [])
    return { app, handleGuildMemberRequest, sendPrivateMessage }
  }

  it('rejects when BiliCode not found in database', async () => {
    const instance = await setupWithDb({ dbVerification: { adminId: '999' } })

    await receiveGroupMemberRequestWithContent(instance.app, '321', 'unknownUID')
    await sleep(50)
    expect(instance.handleGuildMemberRequest.mock.calls).to.have.shape([['flag', false, '请回答你的B站UID']])
  })

  it('approves and updates QQNumber when BiliCode found with empty QQNumber', async () => {
    const instance = await setupWithDb(
      { dbVerification: { adminId: '999' } },
      [{ BiliCode: '12345678', QQNumber: '' }],
    )

    await receiveGroupMemberRequestWithContent(instance.app, '321', '12345678')
    await sleep(50)
    expect(instance.handleGuildMemberRequest.mock.calls).to.have.shape([['flag', true]])
    const rows = await instance.app.database.get('verifyCode', { BiliCode: '12345678' })
    expect(rows[0].QQNumber).to.equal('321')
  })

  it('parses BiliCode from "问题：...\\n答案：<uid>" content format', async () => {
    const instance = await setupWithDb(
      { dbVerification: { adminId: '999' } },
      [{ BiliCode: '12345678', QQNumber: '' }],
    )

    await receiveGroupMemberRequestWithContent(instance.app, '321', '问题：你的B站UID是？\n答案：12345678')
    await sleep(50)
    expect(instance.handleGuildMemberRequest.mock.calls).to.have.shape([['flag', true]])
    const rows = await instance.app.database.get('verifyCode', { BiliCode: '12345678' })
    expect(rows[0].QQNumber).to.equal('321')
  })

  it('notifies admin when BiliCode found with existing QQNumber', async () => {
    const instance = await setupWithDb(
      { dbVerification: { adminId: '999' } },
      [{ BiliCode: '12345678', QQNumber: '100' }],
    )

    await receiveGroupMemberRequestWithContent(instance.app, '321', '12345678')
    await sleep(50)
    expect(instance.handleGuildMemberRequest.mock.calls).to.have.length(0)
    expect(instance.sendPrivateMessage.mock.calls).to.have.shape([['999', '检测到重复用户申请入群，请介入']])
  })

  it('does not send admin message when adminId is not configured', async () => {
    const instance = await setupWithDb(
      { dbVerification: {} },
      [{ BiliCode: '12345678', QQNumber: '100' }],
    )

    await receiveGroupMemberRequestWithContent(instance.app, '321', '12345678')
    await sleep(50)
    expect(instance.handleGuildMemberRequest.mock.calls).to.have.length(0)
    expect(instance.sendPrivateMessage.mock.calls).to.have.length(0)
  })

  it('removes verifyCode record when guild member leaves', async () => {
    const instance = await setupWithDb(
      { dbVerification: { adminId: '999' } },
      [{ BiliCode: '12345678', QQNumber: '321' }],
    )

    await receiveGroupMemberRemoved(instance.app, '321')
    await sleep(50)
    const rows = await instance.app.database.get('verifyCode', { QQNumber: '321' })
    expect(rows).to.have.length(0)
  })

  it('does nothing on guild-member-removed when QQNumber not found', async () => {
    const instance = await setupWithDb(
      { dbVerification: { adminId: '999' } },
      [{ BiliCode: '12345678', QQNumber: '' }],
    )

    await receiveGroupMemberRemoved(instance.app, '999')
    await sleep(50)
    // Original record should be untouched
    const rows = await instance.app.database.get('verifyCode', { BiliCode: '12345678' })
    expect(rows).to.have.length(1)
  })

  it('skips guild-member-request from a guild not in enabledGuilds', async () => {
    const instance = await setupWithDb(
      { dbVerification: { adminId: '999', enabledGuilds: ['10000'] } },
      [{ BiliCode: '12345678', QQNumber: '' }],
    )

    await receiveGroupMemberRequestWithContent(instance.app, '321', '12345678', '99999')
    await sleep(50)
    expect(instance.handleGuildMemberRequest.mock.calls).to.have.length(0)
  })

  it('processes guild-member-request from a guild in enabledGuilds', async () => {
    const instance = await setupWithDb(
      { dbVerification: { adminId: '999', enabledGuilds: ['10000'] } },
      [{ BiliCode: '12345678', QQNumber: '' }],
    )

    await receiveGroupMemberRequestWithContent(instance.app, '321', '12345678', '10000')
    await sleep(50)
    expect(instance.handleGuildMemberRequest.mock.calls).to.have.shape([['flag', true]])
  })

  it('skips guild-member-removed from a guild not in enabledGuilds', async () => {
    const instance = await setupWithDb(
      { dbVerification: { adminId: '999', enabledGuilds: ['10000'] } },
      [{ BiliCode: '12345678', QQNumber: '321' }],
    )

    await receiveGroupMemberRemoved(instance.app, '321', '99999')
    await sleep(50)
    // Record should NOT be deleted
    const rows = await instance.app.database.get('verifyCode', { QQNumber: '321' })
    expect(rows).to.have.length(1)
  })
})
