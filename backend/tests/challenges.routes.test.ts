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
    await prisma.challenge.upsert({
      where: { id: 'catalog-test-archived-challenge' },
      update: { archived: true },
      create: {
        id: 'catalog-test-archived-challenge',
        title: 'Archived Test Challenge',
        category: 'crud',
        points: 5,
        yamlPath: 'catalog-test-archived-challenge.yaml',
        archived: true,
      },
    })
    await prisma.challenge.upsert({
      where: { id: 'catalog-test-challenge-with-text' },
      update: {},
      create: {
        id: 'catalog-test-challenge-with-text',
        title: 'Challenge With Text',
        category: 'crud',
        points: 5,
        yamlPath: 'catalog-test-challenge-with-text.yaml',
        description: 'Some description',
        objective: 'Some objective',
        technicalDetails: 'Some technical details',
      },
    })
  })

  afterAll(async () => {
    await prisma.challenge.delete({ where: { id: 'catalog-test-challenge' } }).catch(() => {})
    await prisma.challenge.delete({ where: { id: 'catalog-test-archived-challenge' } }).catch(() => {})
    await prisma.challenge.delete({ where: { id: 'catalog-test-challenge-with-text' } }).catch(() => {})
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

  it('GET /api/challenges excludes archived challenges', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges')

    expect(res.status).toBe(200)
    expect(res.body.find((c: any) => c.id === 'catalog-test-archived-challenge')).toBeUndefined()
  })

  it('GET /api/challenges/:id returns 404 for an archived challenge', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges/catalog-test-archived-challenge')

    expect(res.status).toBe(404)
  })

  it('GET /api/challenges/:id includes description/objective/technicalDetails when set', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges/catalog-test-challenge-with-text')

    expect(res.status).toBe(200)
    expect(res.body.description).toBe('Some description')
    expect(res.body.objective).toBe('Some objective')
    expect(res.body.technicalDetails).toBe('Some technical details')
  })

  it('GET /api/challenges/:id returns null text fields when unset', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges/catalog-test-challenge')

    expect(res.status).toBe(200)
    expect(res.body.description).toBeNull()
    expect(res.body.objective).toBeNull()
    expect(res.body.technicalDetails).toBeNull()
  })
})
