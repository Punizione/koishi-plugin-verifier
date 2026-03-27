import { expect, use } from 'chai'
import { App, Element, sleep, Session } from 'koishi'
import shape from 'chai-shape'
import mock, { DEFAULT_SELF_ID } from '@koishijs/plugin-mock'
import memory from '@koishijs/plugin-database-memory'
import * as jest from 'jest-mock'
import * as verifier from '../src'

use(shape)

async function setup(options: verifier.Config) {
  const app = new App()
  app.plugin(mock)
  app.plugin(verifier, options)
  app.start()
  const handleFriendRequest = app.bots[0].handleFriendRequest = jest.fn(async () => {})
  const handleGuildRequest = app.bots[0].handleGuildRequest = jest.fn(async () => {})
  const handleGuildMemberRequest = app.bots[0].handleGuildMemberRequest = jest.fn(async () => {})
  return { app, handleFriendRequest, handleGuildRequest, handleGuildMemberRequest }
}

function receive(app: App, session: Partial<Session>) {
  app.mock.receive(session)
  return sleep(0)
}

const receiveFriendRequest = (app: App, userId: string) => receive(app, {
  platform: 'mock',
  selfId: DEFAULT_SELF_ID,
  type: 'friend-request',
  messageId: 'flag',
  userId,
})

const receiveGroupRequest = (app: App, userId: string) => receive(app, {
  platform: 'mock',
  selfId: DEFAULT_SELF_ID,
  type: 'guild-request',
  guildId: '10000',
  messageId: 'flag',
  userId,
})

const receiveGroupMemberRequest = (app: App, userId: string) => receive(app, {
  platform: 'mock',
  selfId: DEFAULT_SELF_ID,
  type: 'guild-member-request',
  guildId: '10000',
  messageId: 'flag',
  userId,
})

const receiveGroupMemberRequestWithContent = (app: App, userId: string, content: string) => receive(app, {
  platform: 'mock',
  selfId: DEFAULT_SELF_ID,
  type: 'guild-member-request',
  guild: { id: '10000' },
  message: { id: 'flag', elements: Element.parse(content) },
  user: { id: userId },
})

describe('koishi-plugin-verifier', () => {
  it('request handler: undefined', async () => {
    const instance = await setup({})

    await receiveFriendRequest(instance.app, '321')
    expect(instance.handleFriendRequest.mock.calls).to.have.length(0)

    await receiveGroupRequest(instance.app, '321')
    expect(instance.handleGuildRequest.mock.calls).to.have.length(0)

    await receiveGroupMemberRequest(instance.app, '321')
    expect(instance.handleGuildMemberRequest.mock.calls).to.have.length(0)
  })

  it('request handler: string', async () => {
    const instance = await setup({
      onFriendRequest: 'foo',
      onGuildRequest: 'baz',
      onGuildMemberRequest: 'bar',
    })

    await receiveFriendRequest(instance.app, '321')
    expect(instance.handleFriendRequest.mock.calls).to.have.shape([['flag', true, 'foo']])

    await receiveGroupRequest(instance.app, '321')
    expect(instance.handleGuildRequest.mock.calls).to.have.shape([['flag', false, 'baz']])

    await receiveGroupMemberRequest(instance.app, '321')
    expect(instance.handleGuildMemberRequest.mock.calls).to.have.shape([['flag', false, 'bar']])
  })

  it('request handler: boolean', async () => {
    const instance = await setup({
      onFriendRequest: false,
      onGuildRequest: false,
      onGuildMemberRequest: false,
    })

    await receiveFriendRequest(instance.app, '321')
    expect(instance.handleFriendRequest.mock.calls).to.have.shape([['flag', false]])

    await receiveGroupRequest(instance.app, '321')
    expect(instance.handleGuildRequest.mock.calls).to.have.shape([['flag', false]])

    await receiveGroupMemberRequest(instance.app, '321')
    expect(instance.handleGuildMemberRequest.mock.calls).to.have.shape([['flag', false]])
  })

  it('request handler: function', async () => {
    const instance = await setup({
      onFriendRequest: () => true,
      onGuildRequest: () => true,
      onGuildMemberRequest: () => true,
    })

    await receiveFriendRequest(instance.app, '321')
    expect(instance.handleFriendRequest.mock.calls).to.have.shape([['flag', true]])

    await receiveGroupRequest(instance.app, '321')
    expect(instance.handleGuildRequest.mock.calls).to.have.shape([['flag', true]])

    await receiveGroupMemberRequest(instance.app, '321')
    expect(instance.handleGuildMemberRequest.mock.calls).to.have.shape([['flag', true]])
  })
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
})
