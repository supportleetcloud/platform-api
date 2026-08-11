import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

let mockAuthUser = { id: 'challenges-admin-routes-test-admin', isAdmin: true }

jest.mock('passport', () => {
  const actual = jest.requireActual('passport')
  const originalAuthenticate = actual.authenticate.bind(actual)
  return Object.assign(actual, {
    authenticate: (strategy: string, ...args: any[]) => {
      if (strategy === 'session') {
        return originalAuthenticate(strategy, ...args)
      }
      return (req: any, _res: any, next: any) => {
        req.user = { id: mockAuthUser.id, username: 'octocat', avatarUrl: null, isAdmin: mockAuthUser.isAdmin }
        req.login(req.user, (err: Error) => next(err))
      }
    },
  })
})

const prisma = new PrismaClient()
const ADMIN_USER_ID = 'challenges-admin-routes-test-admin'
const NON_ADMIN_USER_ID = 'challenges-admin-routes-test-non-admin'

const VALID_BODY = {
  title: 'Admin Routes Test Challenge',
  category: 'crud',
  checks: [{ name: 'GET /ping', method: 'GET', path: '/ping', expectStatus: 200, points: 10 }],
}

describe('challenges admin routes', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: ADMIN_USER_ID },
      update: { isAdmin: true },
      create: { id: ADMIN_USER_ID, githubId: 'gh-challenges-admin-routes-admin', username: 'admin-octocat', isAdmin: true },
    })
    await prisma.user.upsert({
      where: { id: NON_ADMIN_USER_ID },
      update: { isAdmin: false },
      create: { id: NON_ADMIN_USER_ID, githubId: 'gh-challenges-admin-routes-plain', username: 'plain-octocat', isAdmin: false },
    })
  })

  afterEach(async () => {
    await prisma.challengeCheck.deleteMany({ where: { challenge: { title: { startsWith: 'Admin Routes Test' } } } })
    await prisma.challenge.deleteMany({ where: { title: { startsWith: 'Admin Routes Test' } } })
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: ADMIN_USER_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: NON_ADMIN_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  beforeEach(() => {
    mockAuthUser = { id: ADMIN_USER_ID, isAdmin: true }
  })

  it('every route requires auth (401) and admin (403)', async () => {
    const app = createApp({ prisma })

    expect((await request(app).get('/api/admin/challenges')).status).toBe(401)
    expect((await request(app).post('/api/admin/challenges').send(VALID_BODY)).status).toBe(401)

    mockAuthUser = { id: NON_ADMIN_USER_ID, isAdmin: false }
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')
    expect((await agent.get('/api/admin/challenges')).status).toBe(403)
    expect((await agent.post('/api/admin/challenges').send(VALID_BODY)).status).toBe(403)
  })

  it('full lifecycle: create -> appears in list -> get detail -> update -> archive', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const createRes = await agent.post('/api/admin/challenges').send(VALID_BODY)
    expect(createRes.status).toBe(201)
    const challengeId = createRes.body.challengeId

    const listRes = await agent.get('/api/admin/challenges')
    expect(listRes.status).toBe(200)
    const listEntry = listRes.body.find((c: any) => c.id === challengeId)
    expect(listEntry).toMatchObject({ title: 'Admin Routes Test Challenge', points: 10, archived: false, source: 'database' })

    const getRes = await agent.get(`/api/admin/challenges/${challengeId}`)
    expect(getRes.status).toBe(200)
    expect(getRes.body.checks).toHaveLength(1)

    const updateRes = await agent.put(`/api/admin/challenges/${challengeId}`).send({
      ...VALID_BODY,
      title: 'Admin Routes Test Challenge (updated)',
      checks: [
        { name: 'GET /ping', method: 'GET', path: '/ping', expectStatus: 200, points: 5 },
        { name: 'GET /pong', method: 'GET', path: '/pong', expectStatus: 200, points: 5 },
      ],
    })
    expect(updateRes.status).toBe(200)

    const afterUpdate = await agent.get(`/api/admin/challenges/${challengeId}`)
    expect(afterUpdate.body.title).toBe('Admin Routes Test Challenge (updated)')
    expect(afterUpdate.body.checks).toHaveLength(2)

    const archiveRes = await agent.put(`/api/admin/challenges/${challengeId}/archive`).send({ archived: true })
    expect(archiveRes.status).toBe(200)
    expect(archiveRes.body).toEqual({ archived: true })

    const afterArchive = await agent.get('/api/admin/challenges')
    const archivedEntry = afterArchive.body.find((c: any) => c.id === challengeId)
    expect(archivedEntry.archived).toBe(true)
  })

  it('GET /api/admin/challenges/:id returns 404 for an unknown id', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/admin/challenges/does-not-exist')
    expect(res.status).toBe(404)
  })

  it('POST /api/admin/challenges returns 400 for an invalid body', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/admin/challenges').send({ ...VALID_BODY, title: '' })
    expect(res.status).toBe(400)
  })

  it('PUT /api/admin/challenges/:id returns 404 for an unknown id', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.put('/api/admin/challenges/does-not-exist').send(VALID_BODY)
    expect(res.status).toBe(404)
  })

  it('PUT /api/admin/challenges/:id returns 400 for a file-seeded challenge', async () => {
    const fileChallenge = await prisma.challenge.create({
      data: { title: 'Admin Routes Test File Challenge', category: 'crud', points: 10, yamlPath: 'todo-api-crud.yaml' },
    })

    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.put(`/api/admin/challenges/${fileChallenge.id}`).send(VALID_BODY)
    expect(res.status).toBe(400)

    await prisma.challenge.delete({ where: { id: fileChallenge.id } }).catch(() => {})
  })

  it('PUT /api/admin/challenges/:id/archive returns 400 for a non-boolean archived value', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const createRes = await agent.post('/api/admin/challenges').send(VALID_BODY)
    const res = await agent.put(`/api/admin/challenges/${createRes.body.challengeId}/archive`).send({ archived: 'yes' })
    expect(res.status).toBe(400)
  })

  it('PUT /api/admin/challenges/:id/archive returns 404 for an unknown id', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.put('/api/admin/challenges/does-not-exist/archive').send({ archived: true })
    expect(res.status).toBe(404)
  })
})
