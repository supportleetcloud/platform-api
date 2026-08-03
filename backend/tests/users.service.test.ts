import { PrismaClient } from '@prisma/client'
import { findOrCreateUserByGithubProfile, isAllowlistedAdmin } from '../src/users/service'

const prisma = new PrismaClient()

afterEach(() => {
  delete process.env.ADMIN_GITHUB_USERNAMES
})

describe('users/service', () => {
  beforeEach(async () => {
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a new user from a github profile', async () => {
    const user = await findOrCreateUserByGithubProfile(prisma, {
      id: 'gh-1',
      username: 'octocat',
      photos: [{ value: 'https://example.com/avatar.png' }],
    })

    expect(user.githubId).toBe('gh-1')
    expect(user.username).toBe('octocat')
    expect(user.avatarUrl).toBe('https://example.com/avatar.png')
    expect(user.isAdmin).toBe(false)
  })

  it('updates username on repeat login instead of duplicating', async () => {
    await findOrCreateUserByGithubProfile(prisma, { id: 'gh-1', username: 'octocat' })
    const updated = await findOrCreateUserByGithubProfile(prisma, {
      id: 'gh-1',
      username: 'octocat-renamed',
    })

    const count = await prisma.user.count()
    expect(count).toBe(1)
    expect(updated.username).toBe('octocat-renamed')
  })

  it('marks a user admin when their github username is allowlisted', async () => {
    process.env.ADMIN_GITHUB_USERNAMES = 'foundera,founderb'

    const user = await findOrCreateUserByGithubProfile(prisma, {
      id: 'gh-2',
      username: 'FounderA',
    })

    expect(user.isAdmin).toBe(true)
  })
})

describe('isAllowlistedAdmin', () => {
  it('matches case-insensitively', () => {
    process.env.ADMIN_GITHUB_USERNAMES = 'foundera,founderb'
    expect(isAllowlistedAdmin('FounderA')).toBe(true)
    expect(isAllowlistedAdmin('someone-else')).toBe(false)
  })
})
