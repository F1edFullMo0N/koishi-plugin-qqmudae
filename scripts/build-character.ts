import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { pipeline } from 'node:stream/promises'
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
}

interface Options {
  minHeat: number
  existing: string
  output: string
  archive?: string
  cacheDir: string
}

const LATEST_URL =
  'https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json'

function parseArgs(): Options {
  const args = process.argv.slice(2)

  const options: Options = {
    minHeat: 15,
    existing: 'src/data/characters.json',
    output: 'src/data/characters.generated.json',
    cacheDir: '.cache/bangumi-archive',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--min-heat':
        options.minHeat = Number(args[++i])
        break

      case '--existing':
        options.existing = args[++i]
        break

      case '--output':
        options.output = args[++i]
        break

      case '--archive':
        options.archive = args[++i]
        break

      case '--cache-dir':
        options.cacheDir = args[++i]
        break

      default:
        throw new Error(`未知参数：${arg}`)
    }
  }

  if (!Number.isFinite(options.minHeat) || options.minHeat < 0) {
    throw new Error('--min-heat 必须是 >= 0 的数字')
  }

  return options
}

function resolveFromCwd(file: string): string {
  return path.resolve(process.cwd(), file)
}

function isBadText(value?: string | null): boolean {
  if (!value) return true

  const text = value.trim()

  return (
    !text ||
    text.startsWith('|') ||
    text.startsWith('{') ||
    text.startsWith('}') ||
    text.includes('={') ||
    text.includes('{{') ||
    text.includes('}}')
  )
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
}

/**
 * 只清理“单个字段值”里常见且明确的 Wiki 标记。
 *
 * 不做完整 Wiki parser，避免把复杂内容误解成其它字段。
 */
function cleanWikiScalar(raw: string): string | null {
  let value = raw.trim()

  if (!value) return null

  // 当前字段如果只是一个结构块的开头，则视为“该字段没有简单标量值”。
  if (
    value === '{' ||
    value === '}' ||
    value === '{{' ||
    value === '}}' ||
    value.startsWith('|')
  ) {
    return null
  }

  value = value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/''+/g, '')

  value = decodeBasicEntities(value)
    .replace(/\s+/g, ' ')
    .trim()

  if (isBadText(value)) {
    return null
  }

  return value || null
}

/**
 * 精确读取 Wiki infobox 的某个字段。
 *
 * 关键点：
 * - 只读取 `|key=value` 这一行 `=` 右侧的内容。
 * - `|性别=` 为空时直接视为空，不会错误地把下一行 `|生日=` 当成 gender。
 * - 多个候选 key 按传入顺序匹配。
 */
function getInfoboxField(
  infobox: string | undefined,
  keys: string[],
): string | null {
  if (!infobox) return null

  const wanted = new Set(
    keys.map((key) => key.replace(/\s+/g, '').trim()),
  )

  const lines = infobox.split(/\r?\n/)

  for (const line of lines) {
    const match = line.match(/^\s*\|\s*([^=]+?)\s*=\s*(.*)$/)

    if (!match) continue

    const key = match[1].replace(/\s+/g, '').trim()

    if (!wanted.has(key)) {
      continue
    }

    const value = cleanWikiScalar(match[2])

    // 如果碰到同名的空字段，不跨行读取。
    // 继续搜索只是为了兼容极少数重复字段。
    if (!value) {
      continue
    }

    return value
  }

  return null
}

function normalizeGender(raw?: string | null): string | null {
  if (!raw) return null

  const value = raw
    .trim()
    .toLowerCase()

  if (
    value === '男' ||
    value === '男性' ||
    value === 'male' ||
    value === '♂'
  ) {
    return '男'
  }

  if (
    value === '女' ||
    value === '女性' ||
    value === 'female' ||
    value === '♀'
  ) {
    return '女'
  }

  // 兼容少量带补充说明的简单值，例如 “女（人类）”。
  if (/^男(?:性)?(?:\s|（|\(|$)/.test(raw.trim())) {
    return '男'
  }

  if (/^女(?:性)?(?:\s|（|\(|$)/.test(raw.trim())) {
    return '女'
  }

  return null
}

function getArchiveName(row: ArchiveCharacter): string | null {
  return getInfoboxField(
    row.infobox,
    [
      '简体中文名',
      '簡體中文名',
      '中文名',
      '中文姓名',
    ],
  )
}

function getArchiveGender(row: ArchiveCharacter): string | null {
  const raw = getInfoboxField(
    row.infobox,
    [
      '性别',
      '性別',
      '性别/性別',
    ],
  )

  return normalizeGender(raw)
}

function validOldName(value?: string | null): string | null {
  if (isBadText(value)) return null
  return value!.trim()
}

function validOldGender(value?: string | null): string | null {
  return normalizeGender(value)
}

function buildImageUrl(id: number): string {
  return `https://api.bgm.tv/v0/characters/${id}/image?type=large`
}

function convertCharacter(
  row: ArchiveCharacter,
  old?: Character,
): Character {
  const archiveName = getArchiveName(row)
  const oldName = validOldName(old?.name)
  const rawName = validOldName(row.name)

  const name =
    archiveName ??
    oldName ??
    rawName ??
    `未知角色 ${row.id}`

  const oldAlias = validOldName(old?.alias)

  // alias 用 Bangumi 原始角色名做最终兜底。
  const alias =
    oldAlias ??
    rawName ??
    name

  const archiveGender = getArchiveGender(row)
  const oldGender = validOldGender(old?.gender)

  const gender =
    archiveGender ??
    oldGender ??
    null

  const heat = Math.max(
    0,
    Math.round(Number(row.collects ?? old?.heat ?? 0)),
  )

  const image =
    old?.image?.filter(
      (url) =>
        typeof url === 'string' &&
        url.trim().length > 0,
    ) ?? []

  return {
    id: row.id,
    name,
    alias,
    heat,
    gender,
    image:
      image.length > 0
        ? image
        : [buildImageUrl(row.id)],
  }
}

function loadExisting(file: string): Map<number, Character> {
  if (!fs.existsSync(file)) {
    console.log(`ℹ️ 未找到旧角色库：${file}`)
    return new Map()
  }

  const parsed = JSON.parse(
    fs.readFileSync(file, 'utf8'),
  ) as Character[]

  const map = new Map<number, Character>()

  for (const character of parsed) {
    map.set(Number(character.id), character)
  }

  console.log(`✅ 读取现有角色：${map.size}`)
  return map
}

async function fetchLatestInfo(): Promise<LatestArchiveInfo> {
  console.log('🔎 获取 Bangumi Archive 最新版本信息……')

  const response = await fetch(LATEST_URL, {
    headers: {
      'User-Agent': 'KoishiPlugin-QQMudae character builder',
    },
  })

  if (!response.ok) {
    throw new Error(
      `获取 latest.json 失败：HTTP ${response.status}`,
    )
  }

  const latest =
    await response.json() as LatestArchiveInfo

  if (
    !latest.browser_download_url ||
    !latest.name
  ) {
    throw new Error('latest.json 缺少必要字段')
  }

  console.log(`📦 最新 Archive：${latest.name}`)

  if (latest.size) {
    console.log(
      `📦 压缩包大小：${(
        latest.size /
        1024 /
        1024
      ).toFixed(1)} MB`,
    )
  }

  return latest
}

async function downloadArchive(
  url: string,
  output: string,
): Promise<void> {
  if (fs.existsSync(output)) {
    console.log(`✅ 使用缓存 Archive：${output}`)
    return
  }

  fs.mkdirSync(
    path.dirname(output),
    { recursive: true },
  )

  console.log(`⬇️ 下载：${url}`)

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'KoishiPlugin-QQMudae character builder',
    },
    redirect: 'follow',
  })

  if (
    !response.ok ||
    !response.body
  ) {
    throw new Error(
      `下载 Archive 失败：HTTP ${response.status}`,
    )
  }

  const temp = `${output}.part`

  await pipeline(
    response.body as any,
    fs.createWriteStream(temp),
  )

  fs.renameSync(temp, output)

  console.log(`✅ 下载完成：${output}`)
}

async function getArchivePath(
  options: Options,
): Promise<string> {
  if (options.archive) {
    const local = resolveFromCwd(options.archive)

    if (!fs.existsSync(local)) {
      throw new Error(
        `指定的 Archive 不存在：${local}`,
      )
    }

    return local
  }

  const latest = await fetchLatestInfo()

  const cacheDir =
    resolveFromCwd(options.cacheDir)

  const output =
    path.join(cacheDir, latest.name)

  await downloadArchive(
    latest.browser_download_url,
    output,
  )

  return output
}

async function findCharacterEntry(
  archivePath: string,
) {
  console.log(`📖 打开 Archive：${archivePath}`)

  const directory =
    await unzipper.Open.file(archivePath)

  const entry = directory.files.find((file) =>
    file.path.endsWith('character.jsonlines'),
  )

  if (!entry) {
    throw new Error(
      'Archive 中找不到 character.jsonlines',
    )
  }

  console.log(`✅ 找到角色主表：${entry.path}`)

  return entry
}

async function buildCharacters(
  options: Options,
): Promise<Character[]> {
  const existingPath =
    resolveFromCwd(options.existing)

  const existing =
    loadExisting(existingPath)

  // UNION 模式：
  // 先放入完整旧库，Archive 只负责更新匹配记录、添加满足条件的新角色。
  // 不会因为最新 Archive 的阈值或 role 筛选把旧角色删掉。
  const output =
    new Map<number, Character>(existing)

  const archivePath =
    await getArchivePath(options)

  const entry =
    await findCharacterEntry(archivePath)

  const rl = readline.createInterface({
    input: entry.stream(),
    crlfDelay: Infinity,
  })

  let totalRows = 0
  let normalCharacters = 0
  let filteredByHeat = 0
  let parseFailures = 0
  let updatedExisting = 0
  let addedNew = 0

  let archiveNameCount = 0
  let archiveGenderCount = 0

  console.log(`🎯 最低 heat：${options.minHeat}`)

  for await (const line of rl) {
    if (!line.trim()) continue

    totalRows++

    let row: ArchiveCharacter

    try {
      row =
        JSON.parse(line) as ArchiveCharacter
    } catch {
      parseFailures++
      continue
    }

    if (row.role !== 1) {
      continue
    }

    normalCharacters++

    const heat =
      Math.max(
        0,
        Math.round(Number(row.collects ?? 0)),
      )

    if (heat < options.minHeat) {
      filteredByHeat++
      continue
    }

    const old =
      existing.get(row.id)

    if (old) {
      updatedExisting++
    } else {
      addedNew++
    }

    if (getArchiveName(row)) {
      archiveNameCount++
    }

    if (getArchiveGender(row)) {
      archiveGenderCount++
    }

    output.set(
      row.id,
      convertCharacter(row, old),
    )
  }

  const result =
    [...output.values()]

  result.sort(
    (a, b) =>
      Number(b.heat ?? 0) -
        Number(a.heat ?? 0) ||
      Number(a.id) - Number(b.id),
  )

  console.log('')
  console.log('===== 合并统计 =====')
  console.log(`Archive 总记录：${totalRows}`)
  console.log(`普通角色(role=1)：${normalCharacters}`)
  console.log(
    `heat < ${options.minHeat} 被过滤：${filteredByHeat}`,
  )
  console.log(`JSON 解析失败：${parseFailures}`)
  console.log(`更新旧库角色：${updatedExisting}`)
  console.log(`Archive 新增角色：${addedNew}`)
  console.log(
    `保留旧库独有角色：${existing.size - updatedExisting}`,
  )
  console.log(
    `成功解析 Archive 中文名：${archiveNameCount}`,
  )
  console.log(
    `成功解析 Archive 性别：${archiveGenderCount}`,
  )
  console.log(`最终角色数：${result.length}`)
  console.log(
    `比旧库增加：${result.length - existing.size}`,
  )

  return result
}

async function main() {
  const options =
    parseArgs()

  const result =
    await buildCharacters(options)

  const outputPath =
    resolveFromCwd(options.output)

  fs.mkdirSync(
    path.dirname(outputPath),
    { recursive: true },
  )

  fs.writeFileSync(
    outputPath,
    JSON.stringify(result, null, 2) + '\n',
    'utf8',
  )

  console.log('')
  console.log(`✅ 已生成：${outputPath}`)
  console.log('')
  console.log(
    '建议先检查生成文件，再手动替换 src/data/characters.json。',
  )
}

main().catch((error) => {
  console.error('')
  console.error('❌ 构建角色库失败：')
  console.error(error)

  process.exit(1)
})
