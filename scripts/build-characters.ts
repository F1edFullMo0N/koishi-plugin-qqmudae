import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import readline from 'node:readline'

import * as unzipper from 'unzipper'

interface ArchiveCharacter {
  id: number
  role: number
  name: string
  infobox?: string
  summary?: string
  comments?: number
  collects?: number
}

interface Character {
  id: number
  name: string
  alias: string
  heat: number
  gender: string | null
  image: string[]
}

interface LatestArchiveInfo {
  browser_download_url: string
  name: string
  size?: number
  digest?: string
}

interface CliOptions {
  minHeat: number
  existing: string
  output: string
  archive?: string
  cacheDir: string
}

const LATEST_ARCHIVE_INFO =
  'https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json'

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    // 你原来的库最低 heat = 15。
    // 默认降到 5，可以明显扩大卡池，同时过滤几乎没人收藏的条目。
    minHeat: 5,
    existing: 'src/data/characters.json',
    output: 'src/data/characters.generated.json',
    cacheDir: '.cache/bangumi-archive',
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    const readValue = () => {
      const value = argv[++i]
      if (!value) throw new Error(`参数 ${arg} 缺少值`)
      return value
    }

    switch (arg) {
      case '--min-heat':
        options.minHeat = Number(readValue())
        break
      case '--existing':
        options.existing = readValue()
        break
      case '--output':
        options.output = readValue()
        break
      case '--archive':
        options.archive = readValue()
        break
      case '--cache-dir':
        options.cacheDir = readValue()
        break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
      default:
        throw new Error(`未知参数：${arg}`)
    }
  }

  if (!Number.isFinite(options.minHeat) || options.minHeat < 0) {
    throw new Error('--min-heat 必须是 >= 0 的数字')
  }

  return options
}

function printHelp() {
  console.log(`\nBangumi Archive -> QQMudae characters.json\n\n用法：\n  npx tsx scripts/build-characters.ts [options]\n\n选项：\n  --min-heat <n>   最低收藏数 / heat，默认 5\n  --existing <p>   现有角色库，默认 src/data/characters.json\n  --output <p>     输出文件，默认 src/data/characters.generated.json\n  --archive <p>    使用本地 Bangumi Archive zip；不传则自动下载最新版\n  --cache-dir <p>  下载缓存目录，默认 .cache/bangumi-archive\n  -h, --help       显示帮助\n\n例子：\n  npx tsx scripts/build-characters.ts --min-heat 5\n  npx tsx scripts/build-characters.ts --min-heat 1\n  npx tsx scripts/build-characters.ts --archive D:/Downloads/dump.zip --min-heat 1\n`)
}

async function loadExisting(path: string): Promise<Map<number, Character>> {
  const absolute = resolve(path)

  if (!existsSync(absolute)) {
    console.log(`ℹ️ 未找到现有角色库：${absolute}`)
    return new Map()
  }

  const raw = await readFile(absolute, 'utf8')
  const list = JSON.parse(raw) as Character[]

  const map = new Map<number, Character>()
  for (const item of list) {
    if (Number.isSafeInteger(item.id)) {
      map.set(item.id, item)
    }
  }

  console.log(`✅ 读取现有角色：${map.size}`)
  return map
}

async function fetchLatestArchiveInfo(): Promise<LatestArchiveInfo> {
  console.log('🔎 获取 Bangumi Archive 最新版本信息……')

  const response = await fetch(LATEST_ARCHIVE_INFO, {
    headers: {
      'User-Agent': 'KoishiPlugin-QQMudae/character-builder',
    },
  })

  if (!response.ok) {
    throw new Error(
      `获取 latest.json 失败：HTTP ${response.status} ${response.statusText}`,
    )
  }

  return (await response.json()) as LatestArchiveInfo
}

async function downloadFile(url: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })

  if (existsSync(destination)) {
    console.log(`♻️ 使用缓存：${destination}`)
    return
  }

  console.log(`⬇️ 下载：${url}`)

  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'KoishiPlugin-QQMudae/character-builder',
    },
  })

  if (!response.ok || !response.body) {
    throw new Error(
      `下载 Archive 失败：HTTP ${response.status} ${response.statusText}`,
    )
  }

  const input = Readable.fromWeb(response.body as any)
  const output = createWriteStream(destination)

  await pipeline(input, output)
  console.log(`✅ 下载完成：${destination}`)
}

async function resolveArchiveZip(options: CliOptions): Promise<string> {
  if (options.archive) {
    const local = resolve(options.archive)
    if (!existsSync(local)) {
      throw new Error(`找不到 Archive 文件：${local}`)
    }
    return local
  }

  const info = await fetchLatestArchiveInfo()
  const cacheDir = resolve(options.cacheDir)
  const fileName = info.name || basename(new URL(info.browser_download_url).pathname)
  const destination = resolve(cacheDir, fileName)

  console.log(`📦 最新 Archive：${fileName}`)
  if (info.size) {
    console.log(`📦 压缩包大小：${(info.size / 1024 / 1024).toFixed(1)} MB`)
  }

  await downloadFile(info.browser_download_url, destination)
  return destination
}

function findCharacterEntry(files: unzipper.File[]): unzipper.File {
  const regularFiles = files.filter((file) => file.type === 'File')

  // 官方 dump 是 jsonlines；同时兼容常见的 jsonl / ndjson 命名。
  const exactPatterns = [
    /(^|\/)characters?\.(jsonlines|jsonl|ndjson)$/i,
    /(^|\/)characters?\.(json)$/i,
  ]

  for (const pattern of exactPatterns) {
    const found = regularFiles.find((file) => pattern.test(file.path))
    if (found) return found
  }

  // 如果未来官方调整文件名，尽量自动寻找最像“角色主表”的文件。
  const candidates = regularFiles.filter((file) => {
    const path = file.path.toLowerCase()
    const supported = /\.(jsonlines|jsonl|ndjson|json)$/.test(path)
    const hasCharacter = /character/.test(path)
    const relation = /subject|person|relation/.test(path)
    return supported && hasCharacter && !relation
  })

  if (candidates.length === 1) return candidates[0]

  const names = regularFiles
    .filter((file) => /character/i.test(file.path))
    .map((file) => `  - ${file.path}`)
    .join('\n')

  throw new Error(
    `无法自动确认角色主表。Archive 内与 character 有关的文件：\n${names || '  (没有找到)'}`,
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cleanValue(value: string | undefined): string | undefined {
  if (!value) return undefined

  const cleaned = value
    // [[target|text]] -> text, [[text]] -> text
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, '$1')
    // 去掉简单 HTML 标签和常见 wiki 粗体/斜体标记
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/<[^>]+>/g, '')
    .replace(/''+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned || undefined
}

/**
 * 从 Bangumi 的原始 infobox wiki 文本里读取一个“单值字段”。
 *
 * Character Archive 中我们这里只需要：
 *   |简体中文名=...
 *   |性别=...
 *
 * 因此没有必要为了两个字段引入完整 wiki parser，也能避免
 * @bgm38/wiki 在新版本 Node.js / tsx 下的 package exports 兼容问题。
 */
function infoboxScalar(
  raw: string | undefined,
  key: string,
): string | undefined {
  if (!raw?.trim()) return undefined

  const escapedKey = escapeRegExp(key)
  const pattern = new RegExp(
    `^\\s*\\|\\s*${escapedKey}\\s*=\\s*(.*?)\\s*$`,
    'm',
  )

  const match = raw.match(pattern)
  return cleanValue(match?.[1])
}

function makeBangumiImageUrl(id: number): string {
  // 官方 API 会 302 到实际图片；这样不需要在生成阶段逐角色请求 API。
  return `https://api.bgm.tv/v0/characters/${id}/image?type=large`
}

function convertCharacter(
  row: ArchiveCharacter,
  existing: Character | undefined,
): Character {
  const chineseName = infoboxScalar(row.infobox, '简体中文名')
  const gender = infoboxScalar(row.infobox, '性别')

  // 现有库中 alias 基本承担“原名/日文名”的作用。
  // 已有角色优先保留原先人工/历史整理过的 alias 和图片。
  const alias = existing?.alias?.trim() || row.name

  const image =
    existing?.image?.filter(Boolean).length
      ? [...existing.image]
      : [makeBangumiImageUrl(row.id)]

  return {
    id: row.id,
    name: chineseName || existing?.name?.trim() || row.name,
    alias,
    heat: Math.max(0, Math.round(Number(row.collects ?? 0))),
    gender: gender ?? existing?.gender ?? null,
    image,
  }
}

async function buildCharacters(
  zipPath: string,
  existing: Map<number, Character>,
  minHeat: number,
): Promise<Character[]> {
  console.log(`📖 打开 Archive：${zipPath}`)

  const directory = await unzipper.Open.file(zipPath)
  const entry = findCharacterEntry(directory.files)

  console.log(`✅ 找到角色主表：${entry.path}`)
  console.log(`🎯 最低 heat：${minHeat}`)

  if (/\.json$/i.test(entry.path) && !/\.(jsonlines|jsonl|ndjson)$/i.test(entry.path)) {
    throw new Error(
      `检测到 ${entry.path} 是普通 .json。当前脚本针对 Bangumi 官方 jsonlines dump；请确认是否选错了文件。`,
    )
  }

  const output: Character[] = []
  const input = entry.stream() as unknown as Readable
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  })

  let totalRows = 0
  let normalCharacters = 0
  let skippedByHeat = 0
  let parseErrors = 0
  let reusedExisting = 0

  for await (const rawLine of rl) {
    const line = rawLine.replace(/^\uFEFF/, '').trim()
    if (!line) continue

    totalRows++

    let row: ArchiveCharacter
    try {
      row = JSON.parse(line) as ArchiveCharacter
    } catch {
      parseErrors++
      continue
    }

    // Archive 文档：role=1 才是普通角色；机体、组织等不放入人物卡池。
    if (row.role !== 1) continue
    normalCharacters++

    const heat = Math.max(0, Math.round(Number(row.collects ?? 0)))
    if (heat < minHeat) {
      skippedByHeat++
      continue
    }

    const old = existing.get(row.id)
    if (old) reusedExisting++

    output.push(convertCharacter(row, old))

    if (totalRows % 50_000 === 0) {
      console.log(
        `…已读取 ${totalRows.toLocaleString()} 行，当前保留 ${output.length.toLocaleString()} 个角色`,
      )
    }
  }

  output.sort((a, b) => {
    if (b.heat !== a.heat) return b.heat - a.heat
    return a.id - b.id
  })

  console.log('\n===== 转换统计 =====')
  console.log(`Archive 总记录：${totalRows.toLocaleString()}`)
  console.log(`普通角色(role=1)：${normalCharacters.toLocaleString()}`)
  console.log(`heat < ${minHeat} 被过滤：${skippedByHeat.toLocaleString()}`)
  console.log(`JSON 解析失败：${parseErrors.toLocaleString()}`)
  console.log(`复用旧库图片/信息：${reusedExisting.toLocaleString()}`)
  console.log(`最终角色数：${output.length.toLocaleString()}`)
  console.log(`比旧库增加：${(output.length - existing.size).toLocaleString()}`)

  return output
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  const existing = await loadExisting(options.existing)
  const archive = await resolveArchiveZip(options)
  const characters = await buildCharacters(
    archive,
    existing,
    options.minHeat,
  )

  const outputPath = resolve(options.output)
  await mkdir(dirname(outputPath), { recursive: true })

  await writeFile(
    outputPath,
    JSON.stringify(characters, null, 2) + '\n',
    'utf8',
  )

  console.log(`\n✅ 已生成：${outputPath}`)
  console.log('ℹ️ 建议先确认角色数量和抽卡测试，再替换原 characters.json。')
}

main().catch((error) => {
  console.error('\n❌ 生成角色库失败：')
  console.error(error)
  process.exitCode = 1
})
