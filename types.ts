
export interface Comment {
  id: string;
  authorName: string;
  text: string;
  createdAt: number;
}

export interface Profile {
  id: string;
  name: string;
  photoUrl: string;
  birthDate: string;
}

export interface Recipe {
  id: string;
  title: string;
  category: 'entradas' | 'saladas' | 'prato_principal' | 'massas' | 'salgados' | 'sobremesas' | 'bebidas' | 'pães' | 'bolos' | 'tortas' | 'outros';
  ingredients: string;
  instructions: string;
  tips?: string;
  source?: string;
  authorId: string;
  authorName: string;
  externalLink?: string;
  imageUrl?: string;
  createdAt: number;
  favoritedBy?: string[]; // Lista de IDs de perfis que favoritaram
  comments?: Comment[];
}

export enum AppView {
  PROFILE_SELECT,
  PROFILE_CREATE,
  PROFILE_EDIT,
  HOME,
  RECIPE_DETAIL,
  RECIPE_EDIT,
  AI_TOOLS
}