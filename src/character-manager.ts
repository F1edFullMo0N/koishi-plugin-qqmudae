import charactersData from './data/characters.json'

export interface Character {
  id: string | number
  name: string
  heat?: number | string
  image?: string[]
}

export class CharacterManager {
  private characters: Character[]

  constructor() {
    this.characters = charactersData as Character[]
  }

  getRandomCharacter(limit?: number): Character | undefined {
    if (!this.characters.length) {
      return undefined
    }

    let pool = this.characters

    if (limit !== undefined) {
      pool = this.characters.slice(
        0,
        Math.min(limit, this.characters.length),
      )
    }

    if (!pool.length) {
      return undefined
    }

    const index = Math.floor(Math.random() * pool.length)
    return pool[index]
  }

  getCharacterById(id: string | number): Character | undefined {
    return this.characters.find(
      character => String(character.id) === String(id),
    )
  }

  get size(): number {
    return this.characters.length
  }
}