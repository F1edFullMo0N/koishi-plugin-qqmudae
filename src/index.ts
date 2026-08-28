import { Context, h, Session } from 'koishi'
import { CharacterManager } from './character-manager'

export const name = 'qq-mudae'
export const inject = ['database']

// ============================================================
// 基础经济参数
// ============================================================

const DRAW_COST = 100
const DAILY_REWARD = 100

// 出售价格：10 + sqrt(heat) * 1.3，并限制在 10~90。
// 这样普通出售不会直接返还完整一抽，避免无限循环经济。
const SELL_PRICE_MIN = 10
const SELL_PRICE_MAX = 90
const SELL_PRICE_FACTOR = 1.3

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

  // 旧版遗留字段。
  // 当前经济系统已经不再使用“一天只能抽一次”，但先保留字段方便兼容已有数据库。
  lastDrawDate: string
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
// 工具函数
// ============================================================

/**
 * 所有本插件指令都要求用户实际输入 "/"。
 *
 * Koishi 的 "/" 应当配置为“全局指令前缀”，而不是写进 ctx.command() 的指令名中。
 * 群聊中 prefix=/ 会负责解析 /抽卡。
 * 私聊中 Koishi 默认允许无前缀调用，因此这里再做一次硬检查。
 */
function hasSlashPrefix(session: Session): boolean {
  return session.content.trimStart().startsWith('/')
}

/**
 * 群聊：使用真实 guildId。
 * 私聊：给每位用户分配独立私聊作用域，避免不同私聊用户共用同一个假群。
 */
function getScopeId(session: Session): string {
  return session.guildId ?? `private:${session.userId}`
}

/**
 * 游戏自然日统一使用 UTC+8。
 */
function getTodayKey(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function getSellPrice(heat: number): number {
  const safeHeat = Math.max(0, Number.isFinite(heat) ? heat : 0)

  const price = Math.round(
    SELL_PRICE_MIN + Math.sqrt(safeHeat) * SELL_PRICE_FACTOR,
  )

  return Math.min(
    SELL_PRICE_MAX,
    Math.max(SELL_PRICE_MIN, price),
  )
}

async function getOrCreatePlayer(
  ctx: Context,
  session: Session,
): Promise<MudaePlayer> {
  const platform = session.platform
  const guildId = getScopeId(session)
  const userId = session.userId
  const username = session.username || userId

  const [existing] = await ctx.database.get('mudae_player', {
    platform,
    guildId,
    userId,
  })

  if (existing) {
    // 兼容旧数据库：旧记录可能没有新加入的 coins / lastDailyDate。
    const coins = Number(existing.coins ?? 0)
    const lastDailyDate = existing.lastDailyDate ?? ''
    const lastDrawDate = existing.lastDrawDate ?? ''
    const totalHeat = Number(existing.totalHeat ?? 0)

    const updates: Partial<MudaePlayer> = {}

    if (existing.username !== username) updates.username = username
    if (existing.coins == null) updates.coins = coins
    if (existing.lastDailyDate == null) updates.lastDailyDate = lastDailyDate
    if (existing.lastDrawDate == null) updates.lastDrawDate = lastDrawDate
    if (existing.totalHeat == null) updates.totalHeat = totalHeat

    if (Object.keys(updates).length) {
      await ctx.database.set(
        'mudae_player',
        { id: existing.id },
        updates,
      )
    }

    return {
      ...existing,
      username,
      coins,
      lastDailyDate,
      lastDrawDate,
      totalHeat,
    }
  }

  return ctx.database.create('mudae_player', {
    platform,
    guildId,
    userId,
    username,
    totalHeat: 0,
    coins: 0,
    lastDailyDate: '',
    lastDrawDate: '',
  })
}

/**
 * 并列排名采用竞赛排名：
 *
 * 1000 -> 第 1
 * 1000 -> 第 1
 * 800  -> 第 3
 */
async function getPlayerRank(
  ctx: Context,
  platform: string,
  guildId: string,
  totalHeat: number,
): Promise<{ rank: number; totalPlayers: number }> {
  const players = await ctx.database.get('mudae_player', {
    platform,
    guildId,
  })

  const ranked = players
    .filter((player) => Number(player.totalHeat ?? 0) > 0)
    .sort((a, b) => Number(b.totalHeat ?? 0) - Number(a.totalHeat ?? 0))

  if (totalHeat <= 0) {
    return {
      rank: 0,
      totalPlayers: ranked.length,
    }
  }

  const rank =
    ranked.findIndex(
      (player) => Number(player.totalHeat ?? 0) === totalHeat,
    ) + 1

  return {
    rank,
    totalPlayers: ranked.length,
  }
}

/**
 * 从代码层面排除当前作用域内已经被任何人拥有的角色。
 *
 * 用户不会再看到：
 * “这个角色已经被你 / 群友拥有，请重新抽一次。”
 *
 * 实现方式：
 * 1. 一次性读取当前群所有 claim，构造 Set。
 * 2. CharacterManager 随机角色。
 * 3. 如果 ID 已在 Set 中，代码内部立即重抽。
 * 4. 找到未拥有角色后，再查询一次数据库，降低并发撞卡概率。
 *
 * 由于单群通常只拥有卡池中的很小一部分角色，正常情况下几乎第一次就会命中。
 */
async function drawUnclaimedCharacter(
  ctx: Context,
  characterManager: CharacterManager,
  platform: string,
  guildId: string,
) {
  const claims = await ctx.database.get('mudae_claim', {
    platform,
    guildId,
  })

  const claimedIds = new Set(
    claims.map((claim) => String(claim.characterId)),
  )

  if (claimedIds.size >= characterManager.size) {
    return undefined
  }

  const maxAttempts = Math.max(
    500,
    Math.min(characterManager.size * 3, 20000),
  )

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const character = characterManager.getRandomCharacter()

    if (!character) return undefined

    const characterId = String(character.id)

    if (claimedIds.has(characterId)) {
      continue
    }

    // 最后再读一次数据库。
    // 两个人几乎同时抽卡时，如果另一个人刚抢先收录，就继续内部重抽。
    const [latestClaim] = await ctx.database.get('mudae_claim', {
      platform,
      guildId,
      characterId,
    })

    if (latestClaim) {
      claimedIds.add(characterId)
      continue
    }

    return character
  }

  return undefined
}

// ============================================================
// 插件主体
// ============================================================

export function apply(ctx: Context) {
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
      lastDrawDate: {
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

  ctx.logger.info(`已加载 ${characterManager.size} 个角色`)

  // ----------------------------------------------------------
  // /帮助
  // ----------------------------------------------------------

  ctx.command('帮助')
    .alias('菜单')
    .action(({ session }) => {
      if (!hasSlashPrefix(session)) return

      return [
        '🎴 QQMudae 指令',
        '',
        `/签到 - 每日领取 ${DAILY_REWARD} 金币`,
        `/抽卡 - 消耗 ${DRAW_COST} 金币抽取一个本群尚未拥有的角色`,
        '/图鉴 [页码] - 查看自己的角色图鉴',
        '/出售 <角色ID> - 出售自己拥有的角色',
        '/排行 - 查看当前群图鉴人气 Top 10',
        '/终极轮回 - 管理员重置当前群全部游戏数据',
        '',
      ].join('\n')
    })

  // ----------------------------------------------------------
  // /签到
  // ----------------------------------------------------------

  ctx.command('签到')
    .action(async ({ session }) => {
      if (!hasSlashPrefix(session)) return

      const player = await getOrCreatePlayer(ctx, session)
      const today = getTodayKey()

      if (player.lastDailyDate === today) {
        return (
          `✅ 你今天已经签到过了。\n` +
          `💰 当前余额：${player.coins}`
        )
      }

      const newCoins = player.coins + DAILY_REWARD

      await ctx.database.set(
        'mudae_player',
        { id: player.id },
        {
          coins: newCoins,
          lastDailyDate: today,
        },
      )

      return (
        `✅ 签到成功！\n` +
        `💰 获得：${DAILY_REWARD} 金币\n` +
        `💰 当前余额：${newCoins}\n` +
        `🎴 /抽卡 每次需要 ${DRAW_COST} 金币。`
      )
    })


  // ----------------------------------------------------------
  // /抽卡
  // ----------------------------------------------------------

  ctx.command('抽卡')
    .action(async ({ session }) => {
      if (!hasSlashPrefix(session)) return

      const player = await getOrCreatePlayer(ctx, session)

      const platform = session.platform
      const guildId = getScopeId(session)
      const userId = session.userId
      const username = session.username || userId

      if (player.coins < DRAW_COST) {
        return (
          `❌ 金币不足。\n` +
          `🎴 抽卡需要：${DRAW_COST} 金币\n` +
          `💰 当前余额：${player.coins}\n` +
          `可以使用 /签到 获取每日金币。`
        )
      }

      // 核心：只接受当前群尚未被任何玩家收录的角色。
      const character = await drawUnclaimedCharacter(
        ctx,
        characterManager,
        platform,
        guildId,
      )

      if (!character) {
        return (
          '❌ 当前没有找到可抽取的未收录角色。\n' +
          '本次不会扣除金币。'
        )
      }

      const characterId = String(character.id)
      const heat = Math.round(Number(character.heat ?? 0))

      // 最终保险。
      // 如果在选中角色到写入数据库之间刚好被别人抢先获得，则不扣金币。
      const [existingClaim] = await ctx.database.get('mudae_claim', {
        platform,
        guildId,
        characterId,
      })

      if (existingClaim) {
        return (
          '⚠️ 该角色刚刚被其他玩家抢先收录。\n' +
          '本次没有扣除金币，请再次使用 /抽卡。'
        )
      }

      await ctx.database.create('mudae_claim', {
        platform,
        guildId,
        characterId,
        userId,
        claimedAt: new Date(),
      })

      const newCoins = player.coins - DRAW_COST
      const newTotalHeat = player.totalHeat + heat

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

      // 私聊不显示群排名。
      if (session.guildId) {
        const { rank, totalPlayers } = await getPlayerRank(
          ctx,
          platform,
          guildId,
          newTotalHeat,
        )

        rankText = `🏆 群排名：第 ${rank}/${totalPlayers} 名\n`
      }

      const sellPrice = getSellPrice(heat)

      const images = character.image ?? []
      const imageUrl =
        images.length > 0
          ? images[Math.floor(Math.random() * images.length)]
          : undefined

      const text =
        `🎉 成功收录：${character.name}\n` +
        `ID：${characterId}\n` +
        `🔥 角色人气：${heat}\n` +
        `💰 消耗：${DRAW_COST} 金币\n` +
        `💰 当前余额：${newCoins}\n` +
        `♻️ 出售价值：${sellPrice} 金币\n` +
        `📖 图鉴总人气：${newTotalHeat}\n` +
        rankText

      if (!imageUrl) {
        return text.trimEnd()
      }

      return [
        h.text(text),
        h.image(imageUrl),
      ]
    })

  // ----------------------------------------------------------
  // /出售 <角色ID>
  // ----------------------------------------------------------

  ctx.command('出售 <characterId:string>')
    .action(async ({ session }, characterId) => {
      if (!hasSlashPrefix(session)) return

      const player = await getOrCreatePlayer(ctx, session)

      const platform = session.platform
      const guildId = getScopeId(session)
      const userId = session.userId

      const id = String(characterId)

      const [claim] = await ctx.database.get('mudae_claim', {
        platform,
        guildId,
        userId,
        characterId: id,
      })

      if (!claim) {
        return (
          `❌ 你的图鉴中没有 ID 为 ${id} 的角色。\n` +
          '使用 /图鉴 可以查看角色 ID。'
        )
      }

      const character = characterManager.getCharacterById(id)

      if (!character) {
        return (
          `❌ 角色库中找不到 ID ${id}。\n` +
          '为防止错误删除，本次出售已取消。'
        )
      }

      const heat = Math.round(Number(character.heat ?? 0))
      const sellPrice = getSellPrice(heat)

      await ctx.database.remove('mudae_claim', {
        id: claim.id,
      })

      const newTotalHeat = Math.max(
        0,
        player.totalHeat - heat,
      )

      const newCoins = player.coins + sellPrice

      await ctx.database.set(
        'mudae_player',
        { id: player.id },
        {
          totalHeat: newTotalHeat,
          coins: newCoins,
        },
      )

      let rankText = ''

      if (session.guildId && newTotalHeat > 0) {
        const { rank, totalPlayers } = await getPlayerRank(
          ctx,
          platform,
          guildId,
          newTotalHeat,
        )

        rankText = `\n🏆 当前群排名：第 ${rank}/${totalPlayers} 名`
      }

      return (
        `♻️ 已出售：${character.name}\n` +
        `🔥 人气：${heat}\n` +
        `💰 获得：${sellPrice} 金币\n` +
        `💰 当前余额：${newCoins}\n` +
        `📖 当前总人气：${newTotalHeat}` +
        rankText +
        '\n🎴 该角色已经重新回到当前群的可抽取卡池。'
      )
    })

  // ----------------------------------------------------------
  // /图鉴 [页码]
  // ----------------------------------------------------------

  ctx.command('图鉴 [page:number]')
    .action(async ({ session }, pageArg) => {
      if (!hasSlashPrefix(session)) return

      const player = await getOrCreatePlayer(ctx, session)

      const platform = session.platform
      const guildId = getScopeId(session)
      const userId = session.userId
      const username = session.username || userId

      const claims = await ctx.database.get('mudae_claim', {
        platform,
        guildId,
        userId,
      })

      // 按获得顺序排列。
      claims.sort((a, b) => a.id - b.id)

      const entries: string[] = []

      for (const claim of claims) {
        const character =
          characterManager.getCharacterById(claim.characterId)

        if (!character) {
          entries.push(
            `未知角色 (ID: ${claim.characterId})`,
          )
          continue
        }

        const heat = Math.round(
          Number(character.heat ?? 0),
        )

        const sellPrice = getSellPrice(heat)

        entries.push(
          `${character.name} (ID: ${character.id})｜人气: ${heat}｜出售: ${sellPrice}`,
        )
      }

      let rankText = ''

      // 私聊中不出现“群排名”。
      if (session.guildId && player.totalHeat > 0) {
        const { rank, totalPlayers } = await getPlayerRank(
          ctx,
          platform,
          guildId,
          player.totalHeat,
        )

        rankText = `🏆 群排名：第 ${rank}/${totalPlayers} 名\n`
      }

      const perPage = 10

      let page =
        Number.isInteger(pageArg) && Number(pageArg) > 0
          ? Number(pageArg)
          : 1

      const totalPages = Math.max(
        1,
        Math.ceil(entries.length / perPage),
      )

      if (page > totalPages) {
        page = totalPages
      }

      const start = (page - 1) * perPage

      const currentEntries = entries.slice(
        start,
        start + perPage,
      )

      const body =
        currentEntries.length > 0
          ? currentEntries.join('\n')
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
    })

  // ----------------------------------------------------------
  // /排行
  // ----------------------------------------------------------

  ctx.command('排行')
    .alias('群排行')
    .action(async ({ session }) => {
      if (!hasSlashPrefix(session)) return

      if (!session.guildId) {
        return '⚠️ /排行 只能在群聊中查看。'
      }

      const platform = session.platform
      const guildId = session.guildId

      const players = await ctx.database.get('mudae_player', {
        platform,
        guildId,
      })

      const rankedPlayers = players
        .filter((player) => Number(player.totalHeat ?? 0) > 0)
        .sort(
          (a, b) =>
            Number(b.totalHeat ?? 0) -
            Number(a.totalHeat ?? 0),
        )
        .slice(0, 10)

      if (!rankedPlayers.length) {
        return '🏆 当前群还没有排名数据。'
      }

      const lines = ['🏆 图鉴人气排行榜 TOP 10']

      let previousHeat: number | undefined
      let previousRank = 0

      rankedPlayers.forEach((player, index) => {
        const heat = Number(player.totalHeat ?? 0)

        const rank =
          previousHeat === heat
            ? previousRank
            : index + 1

        lines.push(
          `${rank}. ${player.username || player.userId}：${heat}`,
        )

        previousHeat = heat
        previousRank = rank
      })

      return lines.join('\n')
    })

  // ----------------------------------------------------------
  // /终极轮回
  // ----------------------------------------------------------

  ctx.command(
    '终极轮回 [confirm:string]',
    '清空当前群的全部 QQMudae 数据',
    { authority: 4 },
  ).action(async ({ session }, confirm) => {
    if (!hasSlashPrefix(session)) return

    if (!session.guildId) {
      return '⚠️ /终极轮回 只能在群聊中执行。'
    }

    if (confirm !== '确认') {
      return (
        '⚠️ 此操作会清空当前群的：\n' +
        '• 全部角色归属\n' +
        '• 全部玩家图鉴\n' +
        '• 金币\n' +
        '• 总人气与排行\n' +
        '• 签到记录\n\n' +
        '如果确定执行，请输入：\n' +
        '/终极轮回 确认'
      )
    }

    const platform = session.platform
    const guildId = session.guildId

    const claimResult = await ctx.database.remove(
      'mudae_claim',
      {
        platform,
        guildId,
      },
    )

    const playerResult = await ctx.database.remove(
      'mudae_player',
      {
        platform,
        guildId,
      },
    )

    return (
      '✅ 终极轮回完成！当前群已重新开始。\n' +
      `清除角色归属：${claimResult.matched ?? 0} 条\n` +
      `清除玩家记录：${playerResult.matched ?? 0} 条`
    )
  })
}
