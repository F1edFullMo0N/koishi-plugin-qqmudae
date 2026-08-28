import { Context, h, Schema, Session } from 'koishi'
import { CharacterManager } from './character-manager'

export const name = 'qq-mudae'
export const inject = ['database']


// ============================================================
// 配置
// ============================================================

export interface Config {
  drawCost: number
  dailyReward: number
  sellPriceMin: number
  sellPriceMax: number
  sellPriceFactor: number
  timezone: string
}

export const Config: Schema<Config> = Schema.object({
  drawCost: Schema.number()
    .min(1)
    .step(1)
    .default(100)
    .description('每次抽卡消耗的金币。'),

  dailyReward: Schema.number()
    .min(0)
    .step(1)
    .default(100)
    .description('每日签到获得的金币。'),

  sellPriceMin: Schema.number()
    .min(0)
    .step(1)
    .default(10)
    .description('角色出售价格的最低值。'),

  sellPriceMax: Schema.number()
    .min(0)
    .step(1)
    .default(90)
    .description('角色出售价格的最高值。'),

  sellPriceFactor: Schema.number()
    .min(0)
    .default(1.3)
    .description('出售价格公式中的人气系数。'),

  timezone: Schema.string()
    .default('Asia/Shanghai')
    .description('签到自然日使用的 IANA 时区，例如 Asia/Shanghai。'),
})

// ============================================================
// 数据库类型
// ============================================================

export interface MudaePlayer {
  id: number
  platform: string
  guildId: string
  userId: string
  username: string
  totalHeat: number
  coins: number
  lastDailyDate: string
}

export interface MudaeClaim {
  id: number
  platform: string
  guildId: string
  characterId: string
  userId: string
  claimedAt: Date
}

declare module 'koishi' {
  interface Tables {
    mudae_player: MudaePlayer
    mudae_claim: MudaeClaim
  }
}

// ============================================================
// 并发锁
// ============================================================

/**
 * 同一个群 / 私聊作用域内的写操作串行执行。
 *
 * 主要防止：
 * - 两个人几乎同时抽到同一个角色；
 * - 同一个用户快速触发两次抽卡导致余额被重复消费；
 * - 出售与抽卡同时操作同一个角色；
 * - 重复签到。
 *
 * 这是单 Koishi 进程内的锁，足以覆盖本插件常见部署方式。
 */
const scopeLocks = new Map<string, Promise<void>>()

async function withScopeLock<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = scopeLocks.get(key) ?? Promise.resolve()

  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })

  scopeLocks.set(key, current)

  await previous

  try {
    return await task()
  } finally {
    release()

    if (scopeLocks.get(key) === current) {
      scopeLocks.delete(key)
    }
  }
}

// ============================================================
// 通用工具
// ============================================================



function getScopeId(session: Session): string {
  return session.guildId ?? `private:${session.userId}`
}

function getScopeLockKey(session: Session): string {
  return `${session.platform}:${getScopeId(session)}`
}

function getTodayKey(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  } catch {
    // 配置的 IANA 时区无效时，退回 UTC+8。
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  }
}

function getSellPrice(
  heat: number,
  config: Config,
): number {
  const safeHeat = Math.max(
    0,
    Number.isFinite(heat) ? heat : 0,
  )

  const minPrice = Math.max(
    0,
    Math.min(config.sellPriceMin, config.sellPriceMax),
  )

  const maxPrice = Math.max(
    minPrice,
    config.sellPriceMax,
  )

  const rawPrice = Math.round(
    minPrice +
    Math.sqrt(safeHeat) * config.sellPriceFactor,
  )

  return Math.min(
    maxPrice,
    Math.max(minPrice, rawPrice),
  )
}

function getCharacterHeat(
  character: {
    heat?: string | number
  },
): number {
  const heat = Number(character.heat ?? 0)

  return Number.isFinite(heat)
    ? Math.max(0, Math.round(heat))
    : 0
}

async function getOrCreatePlayer(
  ctx: Context,
  session: Session,
): Promise<MudaePlayer> {
  const platform = session.platform
  const guildId = getScopeId(session)
  const userId = session.userId
  const username = session.username || userId

  const [player] = await ctx.database.get(
    'mudae_player',
    {
      platform,
      guildId,
      userId,
    },
  )

  if (player) {
    if (player.username !== username) {
      await ctx.database.set(
        'mudae_player',
        { id: player.id },
        { username },
      )

      player.username = username
    }

    return player
  }

  return ctx.database.create('mudae_player', {
    platform,
    guildId,
    userId,
    username,
    totalHeat: 0,
    coins: 0,
    lastDailyDate: '',
  })
}

async function fetchImage(
  url: string,
): Promise<{
  buffer: Buffer
  mime: string
} | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    })

    if (!response.ok) {
      return null
    }

    const contentType =
      response.headers.get('content-type')
      ?? 'image/jpeg'

    if (!contentType.startsWith('image/')) {
      return null
    }

    const arrayBuffer =
      await response.arrayBuffer()

    const buffer =
      Buffer.from(arrayBuffer)

    // 防止异常大图片
    if (buffer.length > 5 * 1024 * 1024) {
      return null
    }

    return {
      buffer,
      mime: contentType.split(';')[0],
    }
  } catch {
    return null
  }
}

async function getPlayerRank(
  ctx: Context,
  platform: string,
  guildId: string,
  userId: string,
): Promise<{
  rank: number
  totalPlayers: number
}> {
  const players = await ctx.database.get(
    'mudae_player',
    {
      platform,
      guildId,
    },
  )

  const ranked = players
    .filter((player) => player.totalHeat > 0)
    .sort((a, b) => b.totalHeat - a.totalHeat)

  const targetIndex = ranked.findIndex(
    (player) => player.userId === userId,
  )

  if (targetIndex < 0) {
    return {
      rank: 0,
      totalPlayers: ranked.length,
    }
  }

  const targetHeat = ranked[targetIndex].totalHeat

  // 竞赛排名：1, 1, 3
  const rank =
    ranked.findIndex(
      (player) => player.totalHeat === targetHeat,
    ) + 1

  return {
    rank,
    totalPlayers: ranked.length,
  }
}

/**
 * 只从当前作用域尚未被任何人收录的角色中抽取。
 *
 * CharacterManager 负责随机并排除已拥有 ID；
 * index.ts 只负责数据库与业务规则。
 */
async function drawUnclaimedCharacter(
  ctx: Context,
  characterManager: CharacterManager,
  platform: string,
  guildId: string,
) {
  const claims = await ctx.database.get(
    'mudae_claim',
    {
      platform,
      guildId,
    },
  )

  const claimedIds = new Set(
    claims.map((claim) =>
      String(claim.characterId),
    ),
  )

  return characterManager
    .getRandomCharacterExcluding(claimedIds)
}

// ============================================================
// 插件主体
// ============================================================

export function apply(
  ctx: Context,
  config: Config,
) {
  // ----------------------------------------------------------
  // 数据模型
  // ----------------------------------------------------------

  ctx.model.extend(
    'mudae_player',
    {
      id: 'unsigned',
      platform: 'string',
      guildId: 'string',
      userId: 'string',
      username: {
        type: 'string',
        initial: '',
      },
      totalHeat: {
        type: 'integer',
        initial: 0,
      },
      coins: {
        type: 'integer',
        initial: 0,
      },
      lastDailyDate: {
        type: 'string',
        initial: '',
      },
    },
    {
      autoInc: true,
    },
  )

  ctx.model.extend(
    'mudae_claim',
    {
      id: 'unsigned',
      platform: 'string',
      guildId: 'string',
      characterId: 'string',
      userId: 'string',
      claimedAt: 'timestamp',
    },
    {
      autoInc: true,
    },
  )

  const characterManager = new CharacterManager()

  ctx.logger.info(
    `已加载 ${characterManager.size} 个角色`,
  )

  // ----------------------------------------------------------
  // /帮助
  // ----------------------------------------------------------

  ctx.command(
    '帮助',
  )
    .alias('菜单')
    .action(({ session }) => {
       [
        '🎴 QQMudae',
        '',
        '【经济】',
        `/签到 - 每日领取 ${config.dailyReward} 金币`,
        `/抽卡 - 消耗 ${config.drawCost} 金币抽取角色`,
        '/余额 - 查看金币与收藏状态',
        '',
        '【收藏】',
        '/图鉴 [页码] - 查看自己的图鉴',
        '/出售 <角色ID> - 出售角色并获得金币',
        '',
        '【排行】',
        '/排行 - 查看当前群图鉴人气 Top 10',
        '',
        '',
        '角色在同一群内只能被一名玩家拥有。',
      ].join('\n')
    })

  // ----------------------------------------------------------
  // /签到
  // ----------------------------------------------------------

  ctx.command(
    '签到',
  )
    .action(async ({ session }) => {
       

      return withScopeLock(
        getScopeLockKey(session),
        async () => {
          const player =
            await getOrCreatePlayer(ctx, session)

          const today =
            getTodayKey(config.timezone)

          if (player.lastDailyDate === today) {
            return (
              '✅ 你今天已经签到过了。\n' +
              `💰 当前余额：${player.coins}`
            )
          }

          const newCoins =
            player.coins + config.dailyReward

          await ctx.database.set(
            'mudae_player',
            { id: player.id },
            {
              coins: newCoins,
              lastDailyDate: today,
            },
          )

          return (
            '✅ 签到成功！\n' +
            `💰 获得：${config.dailyReward} 金币\n` +
            `💰 当前余额：${newCoins}\n`
          )
        },
      )
    })

  // ----------------------------------------------------------
  // /余额
  // ----------------------------------------------------------

  ctx.command(
    '余额',
  )
    .action(async ({ session }) => {
       

      return withScopeLock(
        getScopeLockKey(session),
        async () => {
          const player =
            await getOrCreatePlayer(ctx, session)

          const platform = session.platform
          const guildId = getScopeId(session)
          const userId = session.userId
          const username =
            session.username || userId

          const claims =
            await ctx.database.get(
              'mudae_claim',
              {
                platform,
                guildId,
                userId,
              },
            )

          let rankText = ''

          if (
            session.guildId &&
            player.totalHeat > 0
          ) {
            const {
              rank,
              totalPlayers,
            } = await getPlayerRank(
              ctx,
              platform,
              guildId,
              userId,
            )

            rankText =
              `\n🏆 群排名：第 ${rank}/${totalPlayers} 名`
          }

          return (
            `💰 ${username}\n` +
            `余额：${player.coins}\n` +
            `🔥 总人气：${player.totalHeat}\n` +
            `📦 收录数量：${claims.length}` +
            rankText
          )
        },
      )
    })

  // ----------------------------------------------------------
  // /抽卡
  // ----------------------------------------------------------

  ctx.command(
    '抽卡'
  )
    .alias('ck')
    .action(async ({ session }) => {
       

      return withScopeLock(
        getScopeLockKey(session),
        async () => {
          // 锁内重新读取玩家，确保余额是最新的。
          const player =
            await getOrCreatePlayer(ctx, session)

          const platform = session.platform
          const guildId = getScopeId(session)
          const userId = session.userId
          const username =
            session.username || userId

          if (player.coins < config.drawCost) {
            return (
              '❌ 金币不足。\n' +
              `🎴 抽卡需要：${config.drawCost} 金币\n` +
              `💰 当前余额：${player.coins}\n` +
              '可以使用 /签到 获取每日金币。'
            )
          }

          const character =
            await drawUnclaimedCharacter(
              ctx,
              characterManager,
              platform,
              guildId,
            )

          if (!character) {
            return (
              '❌ 当前没有可抽取的未收录角色。\n' +
              '本次不会扣除金币。'
            )
          }

          const characterId =
            String(character.id)

          const heat =
            getCharacterHeat(character)

          // 锁已经防止本插件实例内同时撞卡。
          // 写入前仍保留一次数据库检查作为最后保险。
          const [existingClaim] =
            await ctx.database.get(
              'mudae_claim',
              {
                platform,
                guildId,
                characterId,
              },
            )

          if (existingClaim) {
            return (
              '⚠️ 该角色刚刚被其他玩家收录。\n' +
              '本次没有扣除金币，请再次使用 /抽卡。'
            )
          }

          await ctx.database.create(
            'mudae_claim',
            {
              platform,
              guildId,
              characterId,
              userId,
              claimedAt: new Date(),
            },
          )

          const newCoins =
            player.coins - config.drawCost

          const newTotalHeat =
            player.totalHeat + heat

          await ctx.database.set(
            'mudae_player',
            { id: player.id },
            {
              username,
              coins: newCoins,
              totalHeat: newTotalHeat,
            },
          )

          let rankText = ''

          if (session.guildId) {
            const {
              rank,
              totalPlayers,
            } = await getPlayerRank(
              ctx,
              platform,
              guildId,
              userId,
            )

            rankText =
              `🏆 群排名：第 ${rank}/${totalPlayers} 名\n`
          }

          const sellPrice =
            getSellPrice(heat, config)

          const images =
            character.image ?? []

          const imageUrl =
            images.length > 0
              ? images[
                  Math.floor(
                    Math.random() *
                    images.length,
                  )
                ]
              : undefined

          const text =
            `🎉 成功收录：${character.name}\n` +
            `ID：${characterId}\n` +
            `🔥 角色人气：${heat}\n` +
            `💰 当前余额：${newCoins}\n` +
            `♻️ 出售价值：${sellPrice} 金币\n` +
            `📖 图鉴总人气：${newTotalHeat}\n` +
            rankText

          if (!imageUrl) {
            return text.trimEnd()
          }

          const image =
            await fetchImage(imageUrl)

          if (!image) {
            return text.trimEnd()
          }

          return [
            h.text(text),
            h.image(
              image.buffer,
              image.mime,
            ),
          ]
        },
      )
    })

  // ----------------------------------------------------------
  // /出售 <角色ID>
  // ----------------------------------------------------------

  ctx.command(
    '出售 <characterId:string>',
  )
    .action(
      async (
        { session },
        characterId,
      ) => {
         

        return withScopeLock(
          getScopeLockKey(session),
          async () => {
            const player =
              await getOrCreatePlayer(
                ctx,
                session,
              )

            const platform =
              session.platform

            const guildId =
              getScopeId(session)

            const userId =
              session.userId

            const id =
              String(characterId)

            const [claim] =
              await ctx.database.get(
                'mudae_claim',
                {
                  platform,
                  guildId,
                  userId,
                  characterId: id,
                },
              )

            if (!claim) {
              return (
                `❌ 你的图鉴中没有 ID 为 ${id} 的角色。\n` +
                '使用 /图鉴 可以查看角色 ID。'
              )
            }

            const character =
              characterManager
                .getCharacterById(id)

            if (!character) {
              return (
                `❌ 角色库中找不到 ID ${id}。\n` +
                '为防止错误删除，本次出售已取消。'
              )
            }

            const heat =
              getCharacterHeat(character)

            const sellPrice =
              getSellPrice(
                heat,
                config,
              )

            await ctx.database.remove(
              'mudae_claim',
              {
                id: claim.id,
              },
            )

            const newTotalHeat =
              Math.max(
                0,
                player.totalHeat - heat,
              )

            const newCoins =
              player.coins + sellPrice

            await ctx.database.set(
              'mudae_player',
              { id: player.id },
              {
                totalHeat:
                  newTotalHeat,
                coins:
                  newCoins,
              },
            )

            let rankText = ''

            if (
              session.guildId &&
              newTotalHeat > 0
            ) {
              const {
                rank,
                totalPlayers,
              } = await getPlayerRank(
                ctx,
                platform,
                guildId,
                userId,
              )

              rankText =
                `\n🏆 当前群排名：第 ${rank}/${totalPlayers} 名`
            }

            return (
              `♻️ 已出售：${character.name}\n` +
              `💰 获得：${sellPrice} 金币\n` +
              `💰 当前余额：${newCoins}\n` +
              `📖 当前总人气：${newTotalHeat}` +
              rankText
            )
          },
        )
      },
    )

  // ----------------------------------------------------------
  // /图鉴 [页码]
  // ----------------------------------------------------------

  ctx.command(
    '图鉴 [page:number]',
  )
    .action(
      async (
        { session },
        pageArg,
      ) => {
         

        return withScopeLock(
          getScopeLockKey(session),
          async () => {
            const player =
              await getOrCreatePlayer(
                ctx,
                session,
              )

            const platform =
              session.platform

            const guildId =
              getScopeId(session)

            const userId =
              session.userId

            const username =
              session.username ||
              userId

            const claims =
              await ctx.database.get(
                'mudae_claim',
                {
                  platform,
                  guildId,
                  userId,
                },
              )

            // 最近获得的角色排在后面，保持稳定顺序。
            claims.sort(
              (a, b) =>
                a.id - b.id,
            )

            const entries: string[] = []

            for (
              const claim of claims
            ) {
              const character =
                characterManager
                  .getCharacterById(
                    claim.characterId,
                  )

              if (!character) {
                entries.push(
                  `未知角色 (ID: ${claim.characterId})`,
                )
                continue
              }

              const heat =
                getCharacterHeat(
                  character,
                )

              const sellPrice =
                getSellPrice(
                  heat,
                  config,
                )

              entries.push(
                `${character.name} (ID: ${character.id})｜人气: ${heat}｜出售: ${sellPrice}`,
              )
            }

            let rankText = ''

            if (
              session.guildId &&
              player.totalHeat > 0
            ) {
              const {
                rank,
                totalPlayers,
              } = await getPlayerRank(
                ctx,
                platform,
                guildId,
                userId,
              )

              rankText =
                `🏆 群排名：第 ${rank}/${totalPlayers} 名\n`
            }

            const perPage = 10

            let page =
              Number.isInteger(
                pageArg,
              ) &&
              Number(pageArg) > 0
                ? Number(pageArg)
                : 1

            const totalPages =
              Math.max(
                1,
                Math.ceil(
                  entries.length /
                    perPage,
                ),
              )

            if (page > totalPages) {
              page = totalPages
            }

            const start =
              (page - 1) *
              perPage

            const currentEntries =
              entries.slice(
                start,
                start + perPage,
              )

            const body =
              currentEntries.length > 0
                ? currentEntries.join(
                    '\n',
                  )
                : '暂无收录角色。'

            return (
              `📖 ${username} 的图鉴\n` +
              `💰 余额：${player.coins}\n` +
              `🔥 总人气：${player.totalHeat}\n` +
              rankText +
              `📦 收录数量：${claims.length}\n` +
              '──────────────\n' +
              body +
              '\n──────────────\n' +
              `第 ${page}/${totalPages} 页`
            )
          },
        )
      },
    )

  // ----------------------------------------------------------
  // /排行
  // ----------------------------------------------------------

  ctx.command(
    '排行',
  )
    .alias('群排行')
    .action(async ({ session }) => {
       

      if (!session.guildId) {
        return '⚠️ /排行 只能在群聊中查看。'
      }

      const platform =
        session.platform

      const guildId =
        session.guildId

      const players =
        await ctx.database.get(
          'mudae_player',
          {
            platform,
            guildId,
          },
        )

      const rankedPlayers =
        players
          .filter(
            (player) =>
              player.totalHeat > 0,
          )
          .sort(
            (a, b) =>
              b.totalHeat -
              a.totalHeat,
          )
          .slice(0, 10)

      if (!rankedPlayers.length) {
        return '🏆 当前群还没有排名数据。'
      }

      const lines = [
        '🏆 图鉴人气排行榜 TOP 10',
      ]

      let previousHeat:
        | number
        | undefined

      let previousRank = 0

      rankedPlayers.forEach(
        (player, index) => {
          const rank =
            previousHeat ===
            player.totalHeat
              ? previousRank
              : index + 1

          lines.push(
            `${rank}. ${
              player.username ||
              player.userId
            }：${player.totalHeat}`,
          )

          previousHeat =
            player.totalHeat

          previousRank =
            rank
        },
      )

      return lines.join('\n')
    })

}
