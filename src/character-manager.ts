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
  getRandomCharacterExcluding(
    excludedIds: Set<string>,
  ): Character | undefined {
    if (
      this.characters.length === 0 ||
      excludedIds.size >= this.characters.length
    ) {
      return undefined
    }

    for (let i = 0; i < 1000; i++) {
      const character = this.getRandomCharacter()

      if (
        character &&
        !excludedIds.has(String(character.id))
      ) {
        return character
      }
    }

    const available = this.characters.filter(
      (character) =>
        !excludedIds.has(String(character.id)),
    )

    if (!available.length) {
      return undefined
    }

    return available[
      Math.floor(Math.random() * available.length)
    ]
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
