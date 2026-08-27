import { Context, h } from 'koishi'
import { CharacterManager } from './character-manager'

export const name = 'qq-mudae'

export const inject = {
  required: ['database'],
}

export interface MudaePlayer {
  id: number
  platform: string
  guildId: string
  userId: string
  username: string
  totalHeat: number
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

function getTodayKey(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

async function getOrCreatePlayer(
  ctx: Context,
  platform: string,
  guildId: string,
  userId: string,
  username: string,
): Promise<MudaePlayer> {
  const [player] = await ctx.database.get('mudae_player', {
    platform,
    guildId,
    userId,
  })

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

  return await ctx.database.create('mudae_player', {
    platform,
    guildId,
    userId,
    username,
    totalHeat: 0,
    lastDrawDate: '',
  })
}

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

  const rankedPlayers = players
    .filter((player) => player.totalHeat > 0)
    .sort((a, b) => b.totalHeat - a.totalHeat)

  const rank = rankedPlayers.findIndex(
    (player) => player.totalHeat === totalHeat,
  ) + 1

  return {
    rank,
    totalPlayers: rankedPlayers.length,
  }
}

export function apply(ctx: Context) {
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

  // ==================== 抽卡 ====================

  ctx.command('抽卡', '随机抽取并收录一个角色')
    .alias('ck')
    .action(async ({ session }) => {
      const platform = session.platform
      const guildId = session.guildId ?? 'sandbox'
      const userId = session.userId
      const username = session.username || userId

      const player = await getOrCreatePlayer(
        ctx,
        platform,
        guildId,
        userId,
        username,
      )

      const today = getTodayKey()

      if (player.lastDrawDate === today) {
        return '⚠️ 你今天已经成功抽过卡了，明天再来吧~'
      }

      const character = characterManager.getRandomCharacter()

      if (!character) {
        return '❌ 卡池为空或角色数据加载失败。'
      }

      const characterId = String(character.id)
      const heat = Math.round(Number(character.heat ?? 0))

      const [existingClaim] = await ctx.database.get('mudae_claim', {
        platform,
        guildId,
        characterId,
      })

      if (existingClaim) {
        if (existingClaim.userId === userId) {
          return (
            `💡 你抽到了 ${character.name}，但你早已将其收录！\n` +
            '今日机会未消耗，请再试一次。'
          )
        }

        return (
          `💔 你抽到了 ${character.name}，但该角色已经被其他玩家收录！\n` +
          '今日机会未消耗，请再试一次。'
        )
      }

      await ctx.database.create('mudae_claim', {
        platform,
        guildId,
        characterId,
        userId,
        claimedAt: new Date(),
      })

      const newTotalHeat = player.totalHeat + heat

      await ctx.database.set(
        'mudae_player',
        { id: player.id },
        {
          username,
          totalHeat: newTotalHeat,
          lastDrawDate: today,
        },
      )

      const { rank, totalPlayers } = await getPlayerRank(
        ctx,
        platform,
        guildId,
        newTotalHeat,
      )

      const images = character.image ?? []
      const imageUrl = images.length
        ? images[Math.floor(Math.random() * images.length)]
        : undefined

      const text =
        `🎉 成功收录：${character.name}\n` +
        `ID：${characterId}\n` +
        `角色人气：${heat}\n` +
        `图鉴总人气：${newTotalHeat}\n` +
        `群排名：第 ${rank}/${totalPlayers} 名\n` +
        '今日抽卡机会已用尽。'

      if (!imageUrl) {
        return text
      }

      return [
        h.text(text + '\n'),
        h.image(imageUrl),
      ]
    })

  // ==================== 图鉴 ====================

  ctx.command('图鉴 [page]', '查看自己的角色图鉴')
    .alias('我的图鉴')
    .alias('我的后宫')
    .action(async ({ session }, pageText) => {
      const platform = session.platform
      const guildId = session.guildId ?? 'sandbox'
      const userId = session.userId
      const username = session.username || userId

      const player = await getOrCreatePlayer(
        ctx,
        platform,
        guildId,
        userId,
        username,
      )

      const claims = await ctx.database.get('mudae_claim', {
        platform,
        guildId,
        userId,
      })

      if (!claims.length) {
        return '📖 你的图鉴空空如也，快去抽卡吧！'
      }

      claims.sort((a, b) => a.id - b.id)

      const entries: string[] = []

      for (const claim of claims) {
        const character = characterManager.getCharacterById(
          claim.characterId,
        )

        if (!character) {
          entries.push(`未知角色 (ID: ${claim.characterId})`)
          continue
        }

        const heat = Math.round(Number(character.heat ?? 0))

        entries.push(
          `${character.name} (ID: ${character.id})｜人气: ${heat}`,
        )
      }

      const { rank, totalPlayers } = await getPlayerRank(
        ctx,
        platform,
        guildId,
        player.totalHeat,
      )

      const perPage = 10
      let page = Number(pageText ?? 1)

      if (!Number.isInteger(page) || page < 1) {
        page = 1
      }

      const totalPages = Math.max(
        1,
        Math.ceil(entries.length / perPage),
      )

      if (page > totalPages) {
        page = totalPages
      }

      const start = (page - 1) * perPage
      const currentEntries = entries.slice(start, start + perPage)

      return (
        `📖 ${username} 的图鉴\n` +
        `总人气：${player.totalHeat}\n` +
        `群排名：第 ${rank}/${totalPlayers} 名\n` +
        `收录数量：${claims.length}\n` +
        '──────────────\n' +
        currentEntries.join('\n') +
        '\n──────────────\n' +
        `第 ${page}/${totalPages} 页`
      )
    })

  // ==================== 群排行 ====================

  ctx.command('排行', '查看当前群的图鉴人气排行')
    .alias('群排行')
    .action(async ({ session }) => {
      const platform = session.platform
      const guildId = session.guildId ?? 'sandbox'

      const players = await ctx.database.get('mudae_player', {
        platform,
        guildId,
      })

      const rankedPlayers = players
        .filter((player) => player.totalHeat > 0)
        .sort((a, b) => b.totalHeat - a.totalHeat)
        .slice(0, 10)

      if (!rankedPlayers.length) {
        return '暂无排名数据。'
      }

      const lines = ['🏆 图鉴人气排行榜 TOP10']

      let previousHeat: number | undefined
      let previousRank = 0

      rankedPlayers.forEach((player, index) => {
        const rank =
          previousHeat === player.totalHeat
            ? previousRank
            : index + 1

        lines.push(
          `${rank}. ${player.username || player.userId}：${player.totalHeat}`,
        )

        previousHeat = player.totalHeat
        previousRank = rank
      })

      return lines.join('\n')
    })

  // ==================== 开发测试 ====================
  // 正式发布前可以删除这个指令。

  ctx.command('刷新自己', '开发阶段：重置自己的今日抽卡状态')
    .action(async ({ session }) => {
      const platform = session.platform
      const guildId = session.guildId ?? 'sandbox'
      const userId = session.userId

      await ctx.database.set(
        'mudae_player',
        {
          platform,
          guildId,
          userId,
        },
        {
          lastDrawDate: '',
        },
      )

      return '✅ 今日抽卡状态已重置。'
    })
}
