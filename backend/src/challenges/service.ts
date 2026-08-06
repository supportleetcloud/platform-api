import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { PrismaClient } from '@prisma/client'

export const CHALLENGES_DIR = path.join(__dirname, '..', '..', 'challenges')

export type ChallengeCheckSpec = {
  points: number
}

export type ParsedChallengeYaml = {
  id: string
  title: string
  category: string
  checks: ChallengeCheckSpec[]
}

export function parseChallengeYaml(yamlText: string): ParsedChallengeYaml {
  return yaml.load(yamlText) as ParsedChallengeYaml
}

export function sumPoints(checks: ChallengeCheckSpec[]): number {
  return checks.reduce((total, check) => total + check.points, 0)
}

export async function seedChallengesFromDirectory(
  prisma: PrismaClient,
  challengesDir: string
): Promise<void> {
  const files = fs.readdirSync(challengesDir).filter((file) => file.endsWith('.yaml'))

  for (const file of files) {
    const yamlText = fs.readFileSync(path.join(challengesDir, file), 'utf-8')
    const parsed = parseChallengeYaml(yamlText)
    const points = sumPoints(parsed.checks)

    await prisma.challenge.upsert({
      where: { id: parsed.id },
      update: { title: parsed.title, category: parsed.category, points, yamlPath: file },
      create: { id: parsed.id, title: parsed.title, category: parsed.category, points, yamlPath: file },
    })
  }
}
