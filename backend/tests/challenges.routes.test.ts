import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

const prisma = new PrismaClient()

describe('Challenge catalog routes', () => {
  beforeAll(async () => {
    await prisma.challenge.upsert({
      where: { id: 'catalog-test-challenge' },
      update: {},
      create: {
        id: 'catalog-test-challenge',
        title: 'Catalog Test Challenge',
        category: 'crud',
        points: 20,
        yamlPath: 'catalog-test-challenge.yaml',
      },
    })
  })

  afterAll(async () => {
    await prisma.challenge.delete({ where: { id: 'catalog-test-challenge' } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('GET /api/challenges lists metadata without the yaml path', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges')

    expect(res.status).toBe(200)
    const entry = res.body.find((c: any) => c.id === 'catalog-test-challenge')
    expect(entry).toEqual({
      id: 'catalog-test-challenge',
      title: 'Catalog Test Challenge',
      category: 'crud',
      points: 20,
    })
  })

  it('GET /api/challenges/:id returns one challenge', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges/catalog-test-challenge')

    expect(res.status).toBe(200)
    expect(res.body.title).toBe('Catalog Test Challenge')
  })

  it('GET /api/challenges/:id returns 404 for an unknown id', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges/does-not-exist')

    expect(res.status).toBe(404)
  })
})
