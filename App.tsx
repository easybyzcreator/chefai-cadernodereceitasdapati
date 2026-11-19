import React, { useState, useEffect, useRef, useMemo } from 'react';
import { AppView, Profile, Recipe, Comment } from './types';
import { LOGO_URL, CATEGORIES, DEFAULT_PROFILE_IMAGE, DEFAULT_RECIPE_IMAGE } from './constants';
import { gemini } from './services/geminiService';
import { db } from './services/firebase';
import { collection, onSnapshot, doc, updateDoc, deleteDoc, query, orderBy, addDoc } from 'firebase/firestore';

const FOOTER_LOGO_URL = "https://i.ibb.co/Xf0T4snH/patitour-2026-01-27-T112542-860.png";
const WHATSAPP_GROUP_URL = "https://chat.whatsapp.com/HOJsnIu7bk1BIrp6k9MMLI?mode=gi_t";

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

const normalizeText = (text: string): string =>
  (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const formatIngredientsLines = (text: string): string[] => {
  if (!text) return [];
  return text
    .split(/\r?\n|;/)
    .map(line => line.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean);
};

const formatInstructionSteps = (text: string): string[] => {
  if (!text) return [];
  const withBreaks = text.replace(/\s+(?=\d+[.)]\s)/g, '\n');
  return withBreaks
    .split(/\r?\n+/)
    .map(step => step.trim())
    .filter(Boolean);
};

const isoToBrDate = (iso: string): string => {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  if (!y || !m || !d) return iso;
  return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
};

const brToIsoDate = (br: string): string | null => {
  const digits = br.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length !== 8) return null;
  const d = parseInt(digits.slice(0, 2), 10);
  const m = parseInt(digits.slice(2, 4), 10);
  const y = parseInt(digits.slice(4, 8), 10);
  if (d < 1 || d > 31 || m < 1 || m > 12 || y < 1900 || y > 2100) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

const maskBrDate = (value: string): string => {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
};

const isRecipeAuthor = (recipe: Recipe | null | undefined, profile: Profile | null): boolean => {
  if (!profile || !recipe) return false;
  if (recipe.authorId && recipe.authorId !== 'anonymous') {
    return recipe.authorId === profile.id;
  }
  return (recipe.authorName || '').trim().toLowerCase() === (profile.name || '').trim().toLowerCase();
};

const isPatiProfile = (profile: Pick<Profile, 'name'> | null | undefined): boolean =>
  normalizeText(profile?.name || '') === 'pati';

const hashProfilePassword = async (password: string): Promise<string> => {
  const trimmed = password.trim();
  if (!trimmed) return '';
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoded = new TextEncoder().encode(`pati_receitas:${trimmed}`);
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // fallback below
  }
  return `plain:${trimmed}`;
};

const compressImage = (base64: string, maxWidth = 1024, quality = 0.82): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        if (width > maxWidth) {
          height = Math.round(height * (maxWidth / width));
          width = maxWidth;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(base64);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => {
      reject(new Error('Não foi possível ler esta imagem. Tente enviar um arquivo JPG ou PNG.'));
    };
    img.src = base64;
  });
};

const App: React.FC = () => {
  const [view, setView] = useState<AppView>(AppView.PROFILE_SELECT);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [search, setSearch] = useState('');
  const [tempSearch, setTempSearch] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [isCategoriesOpen, setIsCategoriesOpen] = useState(false);
  const [showBirthdays, setShowBirthdays] = useState(false);

  const [newProfileName, setNewProfileName] = useState('');
  const [newProfilePhoto, setNewProfilePhoto] = useState('');
  const [newProfileBirth, setNewProfileBirth] = useState('');
  const [newProfilePassword, setNewProfilePassword] = useState('');
  const [removeProfilePassword, setRemoveProfilePassword] = useState(false);
  const [passwordChallenge, setPasswordChallenge] = useState<{
    profile: Profile;
    action: 'enter' | 'edit' | 'delete';
  } | null>(null);
  const [passwordChallengeInput, setPasswordChallengeInput] = useState('');
  const [passwordChallengeError, setPasswordChallengeError] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);

  const searchContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const savedProfileId = localStorage.getItem('active_profile_id');
    if (savedProfileId && profiles.length > 0 && !activeProfile) {
      const found = profiles.find(p => p.id === savedProfileId);
      if (found && !found.passwordHash) {
        setActiveProfile(found);
      }
    }
  }, [profiles, activeProfile]);

  useEffect(() => {
    const qProfiles = query(collection(db, "profiles"), orderBy("name"));
    const unsubProfiles = onSnapshot(qProfiles, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Profile));
      setProfiles(data);
    });

    const qRecipes = query(collection(db, "recipes"), orderBy("createdAt", "desc"));
    const unsubRecipes = onSnapshot(qRecipes, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Recipe));
      setRecipes(data);
    });

    return () => {
      unsubProfiles();
      unsubRecipes();
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        setIsSearchFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [view, showBirthdays, editingRecipe?.id, categoryFilter]);

  const sortedProfiles = useMemo(() => {
    return [...profiles].sort((a, b) => {
      const aIsPati = isPatiProfile(a);
      const bIsPati = isPatiProfile(b);
      if (aIsPati && !bIsPati) return -1;
      if (!aIsPati && bIsPati) return 1;
      return (a.name || '').trim().localeCompare((b.name || '').trim(), 'pt-BR', { sensitivity: 'base' });
    });
  }, [profiles]);

  const sortedRecipes = useMemo(() => {
    return [...recipes].sort((a, b) =>
      (a.title || '').trim().localeCompare((b.title || '').trim(), 'pt-BR', { sensitivity: 'base' })
    );
  }, [recipes]);

  const searchSuggestions = useMemo(() => {
    const queryNorm = normalizeText(tempSearch);
    if (!queryNorm) return [];

    const scored = sortedRecipes
      .map(r => {
        const titleNorm = normalizeText(r.title);
        const ingredientsNorm = normalizeText(r.ingredients);
        const authorNorm = normalizeText(r.authorName);

        let score = 0;
        if (titleNorm.startsWith(queryNorm)) score = 3;
        else if (titleNorm.includes(queryNorm)) score = 2;
        else if (ingredientsNorm.includes(queryNorm) || authorNorm.includes(queryNorm)) score = 1;

        return { recipe: r, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.recipe.title || '').trim().localeCompare((b.recipe.title || '').trim(), 'pt-BR', { sensitivity: 'base' });
      })
      .slice(0, 7)
      .map(item => item.recipe);

    return scored;
  }, [tempSearch, sortedRecipes]);

  const handleSaveProfile = async () => {
    if (!newProfileName.trim()) return;
    const isoBirthDate = brToIsoDate(newProfileBirth);
    if (isoBirthDate === null) {
      alert("Por favor, informe a data de nascimento completa no formato DD/MM/AAAA.");
      return;
    }

    const canHavePassword = isPatiProfile(editingProfile) || isPatiProfile({ name: newProfileName });
    let nextPasswordHash = '';
    if (canHavePassword) {
      if (removeProfilePassword) {
        nextPasswordHash = '';
      } else if (newProfilePassword.trim()) {
        nextPasswordHash = await hashProfilePassword(newProfilePassword);
      } else if (editingProfile?.passwordHash) {
        nextPasswordHash = editingProfile.passwordHash;
      }
    }

    const profileData = {
      name: newProfileName.trim(),
      photoUrl: newProfilePhoto || DEFAULT_PROFILE_IMAGE,
      birthDate: isoBirthDate,
      passwordHash: nextPasswordHash,
    };
    try {
      if (editingProfile) {
        await updateDoc(doc(db, "profiles", editingProfile.id), profileData);
        if (activeProfile?.id === editingProfile.id) {
          setActiveProfile({ id: editingProfile.id, ...profileData });
        }
      } else {
        await addDoc(collection(db, "profiles"), profileData);
      }
    } catch (e) {
      console.error("Erro ao salvar perfil:", e);
      alert("Erro ao salvar perfil.");
    }
    setView(AppView.PROFILE_SELECT);
    setEditingProfile(null);
    setNewProfileName('');
    setNewProfilePhoto('');
    setNewProfileBirth('');
    setNewProfilePassword('');
    setRemoveProfilePassword(false);
  };

  const openProfileEditor = (p: Profile) => {
    setEditingProfile(p);
    setNewProfileName(p.name);
    setNewProfilePhoto(p.photoUrl);
    setNewProfileBirth(isoToBrDate(p.birthDate || ''));
    setNewProfilePassword('');
    setRemoveProfilePassword(false);
    setView(AppView.PROFILE_EDIT);
  };

  const enterProfile = (p: Profile) => {
    setActiveProfile(p);
    if (p.passwordHash) {
      localStorage.removeItem('active_profile_id');
    } else {
      localStorage.setItem('active_profile_id', p.id);
    }
    setShowBirthdays(false);
    setView(AppView.HOME);
  };

  const handleProfileAction = (p: Profile, action: 'enter' | 'edit' | 'delete') => {
    if (isPatiProfile(p) && p.passwordHash) {
      setPasswordChallenge({ profile: p, action });
      setPasswordChallengeInput('');
      setPasswordChallengeError(false);
      return;
    }
    if (action === 'enter') {
      enterProfile(p);
    } else if (action === 'edit') {
      openProfileEditor(p);
    } else {
      handleDeleteProfile(p.id);
    }
  };

  const handleConfirmProfilePassword = async () => {
    if (!passwordChallenge) return;
    const { profile, action } = passwordChallenge;
    const enteredHash = await hashProfilePassword(passwordChallengeInput);
    const matches =
      Boolean(passwordChallengeInput.trim()) &&
      (enteredHash === profile.passwordHash || `plain:${passwordChallengeInput.trim()}` === profile.passwordHash);

    if (!matches) {
      setPasswordChallengeError(true);
      return;
    }

    setPasswordChallenge(null);
    setPasswordChallengeInput('');
    setPasswordChallengeError(false);

    if (action === 'enter') {
      enterProfile(profile);
    } else if (action === 'edit') {
      openProfileEditor(profile);
    } else {
      await handleDeleteProfile(profile.id);
    }
  };

  const handleDeleteProfile = async (profileId: string) => {
    if (window.confirm('Deseja realmente excluir este perfil da família? Todas as receitas enviadas por ele continuarão salvas.')) {
      try {
        await deleteDoc(doc(db, "profiles", profileId));
        if (activeProfile?.id === profileId) {
          setActiveProfile(null);
          localStorage.removeItem('active_profile_id');
        }
      } catch (e) {
        alert("Erro ao excluir perfil.");
      }
    }
  };

  const handleProfilePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      const reader = new FileReader();
      reader.onloadend = async () => {
        try {
          const compressed = await compressImage(reader.result as string, 300, 0.75);
          setNewProfilePhoto(compressed);
        } catch (err: any) {
          alert(err?.message || 'Não foi possível carregar a foto de perfil.');
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleWhatsAppShare = (recipeTitle: string) => {
    const message = encodeURIComponent(`Olha a receita nova que acabei de postar no nosso caderno: ${recipeTitle}! Confere lá no chef.ai 🍳`);
    window.open(`https://api.whatsapp.com/send?text=${message}`, '_blank');
  };

  const saveRecipe = async (recipeData: Partial<Recipe>) => {
    const normalizedIngredients = formatIngredientsLines(recipeData.ingredients || '').join('\n');
    const normalizedInstructions = formatInstructionSteps(recipeData.instructions || '').join('\n');
    const cleanedData: Partial<Recipe> = {
      ...recipeData,
      ingredients: normalizedIngredients || recipeData.ingredients || '',
      instructions: normalizedInstructions || recipeData.instructions || '',
    };

    try {
      if (editingRecipe) {
        if (!isRecipeAuthor(editingRecipe, activeProfile)) {
          alert("Apenas quem incluiu esta receita pode editá-la.");
          return;
        }
        await updateDoc(doc(db, "recipes", editingRecipe.id), cleanedData);
      } else {
        const newRecipeData = {
          createdAt: Date.now(),
          authorId: activeProfile?.id || 'anonymous',
          authorName: cleanedData.authorName || activeProfile?.name || 'Visitante',
          title: cleanedData.title || 'Sem título',
          category: (cleanedData.category as any) || 'outros',
          ingredients: cleanedData.ingredients || '',
          instructions: cleanedData.instructions || '',
          tips: cleanedData.tips || '',
          source: cleanedData.source || '',
          externalLink: cleanedData.externalLink || '',
          imageUrl: cleanedData.imageUrl || DEFAULT_RECIPE_IMAGE,
          favoritedBy: [],
          comments: [],
        };
        await addDoc(collection(db, "recipes"), newRecipeData);
        if (window.confirm("Receita guardada! Deseja compartilhar agora no WhatsApp da família?")) {
          handleWhatsAppShare(newRecipeData.title);
        }
      }
    } catch (e) {
      alert("Erro ao salvar receita.");
    }
    setEditingRecipe(null);
    setView(AppView.HOME);
  };

  const toggleFavorite = async (recipeId: string) => {
    if (!activeProfile) return;
    const recipe = recipes.find(r => r.id === recipeId);
    if (recipe) {
      const favoritedBy = recipe.favoritedBy || [];
      const newFavoritedBy = favoritedBy.includes(activeProfile.id)
        ? favoritedBy.filter(id => id !== activeProfile.id)
        : [...favoritedBy, activeProfile.id];
      await updateDoc(doc(db, "recipes", recipeId), { favoritedBy: newFavoritedBy });
    }
  };

  const addComment = async (recipeId: string, text: string) => {
    if (!text.trim() || !activeProfile) return;
    const recipe = recipes.find(r => r.id === recipeId);
    if (recipe) {
      const newComment: Comment = {
        id: Date.now().toString(),
        authorName: activeProfile.name,
        text,
        createdAt: Date.now(),
      };
      await updateDoc(doc(db, "recipes", recipeId), {
        comments: [...(recipe.comments || []), newComment]
      });
    }
  };

  const deleteRecipe = async (id: string) => {
    const target = recipes.find(r => r.id === id);
    if (target && !isRecipeAuthor(target, activeProfile)) {
      alert("Apenas quem incluiu esta receita pode excluí-la.");
      return;
    }
    if (window.confirm('Tem certeza que deseja excluir esta receita preciosa?')) {
      await deleteDoc(doc(db, "recipes", id));
      setEditingRecipe(null);
      setView(AppView.HOME);
    }
  };

  const currentMonthIndex = new Date().getMonth();
  const currentMonthName = MONTH_NAMES[currentMonthIndex];

  const birthdayProfiles = useMemo(() => {
    const currentMonth = currentMonthIndex + 1;
    return sortedProfiles
      .filter(p => {
        if (!p.birthDate) return false;
        const parts = p.birthDate.split('-');
        if (parts.length < 2) return false;
        const month = parseInt(parts[1], 10);
        return month === currentMonth;
      })
      .sort((a, b) => {
        const dayA = parseInt(a.birthDate.split('-')[2] || '0', 10);
        const dayB = parseInt(b.birthDate.split('-')[2] || '0', 10);
        return dayA - dayB;
      });
  }, [sortedProfiles, currentMonthIndex]);

  const Footer = () => (
    <footer className="w-full pt-12 pb-10 flex flex-col items-center justify-center bg-[#f9f5ef] border-t border-[#522f19]/10">
      <span className="text-[10px] uppercase tracking-[0.4em] text-[#522f19]/50 font-bold mb-4">Desenvolvido por</span>
      <a href="https://www.easybyzcreator.com" target="_blank" rel="noopener noreferrer" className="block">
        <img
          src={FOOTER_LOGO_URL}
          alt="Easy Byz Creator"
          referrerPolicy="no-referrer"
          className="w-28 h-auto grayscale opacity-50 hover:grayscale-0 hover:opacity-100 active:scale-95 transition-all duration-500 cursor-pointer"
        />
      </a>
    </footer>
  );

  const currentDetailRecipe = editingRecipe
    ? recipes.find(r => r.id === editingRecipe.id) || editingRecipe
    : null;

  const renderContent = () => {
    if (view === AppView.PROFILE_SELECT) {
      return (
        <div className="min-h-screen bg-[#f9f5ef] px-6 py-12 flex flex-col items-center text-center fade-in">
          <img
            src={LOGO_URL}
            alt="Logo Caderno da Pati"
            referrerPolicy="no-referrer"
            className="w-[180px] h-[180px] rounded-full border-2 border-white mb-7 shadow-lg object-cover bg-[#fffcf7]"
          />
          <p className="font-display italic text-[#522f19]/80 text-base sm:text-lg leading-relaxed max-w-lg mb-8 px-4">
            "Nosso caderno de receitas virou app! Agora a gente compartilha segredos de cozinha e deixa tudo guardado aqui. Vamos cozinhar juntas?"
          </p>
          <h2 className="text-3xl sm:text-4xl font-display font-bold text-[#522f19] mb-10">
            Quem está cozinhando hoje?
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-8 w-full max-w-xl">
            {sortedProfiles.map(p => (
              <div key={p.id} className="relative group flex flex-col items-center">
                <button
                  onClick={() => handleProfileAction(p, 'enter')}
                  className="flex flex-col items-center w-full focus:outline-none"
                >
                  <div className="p-1.5 rounded-full bg-[#fffcf7] border border-[#522f19]/15 group-hover:border-[#AF5E33] shadow-sm transition-all mb-3">
                    <img
                      src={p.photoUrl || DEFAULT_PROFILE_IMAGE}
                      alt={p.name}
                      referrerPolicy="no-referrer"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_IMAGE; }}
                      className="w-24 h-24 sm:w-28 sm:h-28 rounded-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  </div>
                  <span className="font-display font-semibold text-lg text-[#522f19] group-hover:text-[#AF5E33] transition-colors inline-flex items-center gap-1.5">
                    <span>{p.name}</span>
                    {isPatiProfile(p) && p.passwordHash && (
                      <svg className="w-3.5 h-3.5 text-[#AF5E33] shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-label="Perfil protegido por senha">
                        <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6z" />
                      </svg>
                    )}
                  </span>
                </button>
                <div className="absolute top-0 right-1 sm:right-2 flex flex-col gap-1.5">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleProfileAction(p, 'edit'); }}
                    title="Editar perfil"
                    className="bg-[#fffcf7] shadow-sm border border-[#522f19]/15 w-8 h-8 rounded-full text-xs flex items-center justify-center hover:border-[#AF5E33] hover:text-[#AF5E33] transition-colors"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleProfileAction(p, 'delete'); }}
                    title="Excluir perfil"
                    className="bg-[#fffcf7] shadow-sm border border-[#522f19]/15 w-8 h-8 rounded-full text-xs flex items-center justify-center hover:border-red-500 hover:text-red-600 transition-colors"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))}
            <button
              onClick={() => {
                setEditingProfile(null);
                setNewProfileName('');
                setNewProfilePhoto('');
                setNewProfileBirth('');
                setNewProfilePassword('');
                setRemoveProfilePassword(false);
                setView(AppView.PROFILE_CREATE);
              }}
              className="flex flex-col items-center group"
            >
              <div className="w-[108px] h-[108px] sm:w-[124px] sm:h-[124px] rounded-full bg-[#fffcf7]/70 border-2 border-dashed border-[#522f19]/25 flex items-center justify-center group-hover:border-[#AF5E33] group-hover:bg-[#fffcf7] transition-all mb-3">
                <svg className="w-10 h-10 text-[#522f19]/30 group-hover:text-[#AF5E33] transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                </svg>
              </div>
              <span className="font-semibold text-sm text-[#522f19]/55 group-hover:text-[#AF5E33] transition-colors">
                Novo Perfil
              </span>
            </button>
          </div>

          {passwordChallenge && (
            <div className="fixed inset-0 bg-[#522f19]/60 backdrop-blur-sm flex items-center justify-center p-4 z-[100]">
              <div className="bg-[#fffcf7] rounded-3xl p-7 max-w-sm w-full space-y-5 shadow-2xl border border-[#522f19]/15 text-center fade-in">
                <img
                  src={passwordChallenge.profile.photoUrl || DEFAULT_PROFILE_IMAGE}
                  alt={passwordChallenge.profile.name}
                  referrerPolicy="no-referrer"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_IMAGE; }}
                  className="w-20 h-20 rounded-full object-cover mx-auto border-2 border-[#AF5E33] shadow-sm"
                />
                <div className="space-y-1">
                  <h3 className="text-xl font-display font-bold text-[#522f19]">
                    Perfil de {passwordChallenge.profile.name}
                  </h3>
                  <p className="text-xs text-[#522f19]/70">
                    {passwordChallenge.action === 'enter'
                      ? 'Digite a senha para acessar este perfil e gerenciar suas receitas.'
                      : passwordChallenge.action === 'edit'
                        ? 'Digite a senha para editar este perfil.'
                        : 'Digite a senha para confirmar a exclusão deste perfil.'}
                  </p>
                </div>
                <input
                  type="password"
                  autoFocus
                  placeholder="Digite a senha..."
                  className={`w-full p-3.5 rounded-2xl border bg-[#f9f5ef] text-[#522f19] text-sm outline-none transition-all ${
                    passwordChallengeError
                      ? 'border-red-500 bg-red-50 animate-shake'
                      : 'border-[#522f19]/20 focus:border-[#AF5E33]'
                  }`}
                  value={passwordChallengeInput}
                  onChange={e => {
                    setPasswordChallengeInput(e.target.value);
                    setPasswordChallengeError(false);
                  }}
                  onKeyDown={e => e.key === 'Enter' && handleConfirmProfilePassword()}
                />
                {passwordChallengeError && (
                  <p className="text-xs font-semibold text-red-600">
                    Senha incorreta. Tente novamente.
                  </p>
                )}
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setPasswordChallenge(null);
                      setPasswordChallengeInput('');
                      setPasswordChallengeError(false);
                    }}
                    className="flex-1 py-3 bg-[#f2ebe0] hover:bg-[#e7ddd0] text-[#522f19] rounded-full font-semibold text-xs uppercase tracking-wider transition-all"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmProfilePassword}
                    className="flex-1 py-3 bg-[#AF5E33] hover:bg-[#934c27] text-[#f9f5ef] rounded-full font-semibold text-xs uppercase tracking-wider shadow-sm transition-all active:scale-95"
                  >
                    Entrar
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (view === AppView.PROFILE_CREATE || view === AppView.PROFILE_EDIT) {
      return (
        <div className="min-h-screen bg-[#f9f5ef] p-6 flex flex-col fade-in">
          <div className="max-w-md mx-auto w-full">
            <button
              onClick={() => setView(AppView.PROFILE_SELECT)}
              className="text-[#AF5E33] mb-6 flex items-center gap-2 font-semibold hover:underline"
            >
              ← Voltar
            </button>
            <div className="bg-[#fffcf7] p-8 rounded-3xl shadow-[0_10px_30px_-12px_rgba(82,47,25,0.14)] space-y-6 border border-[#522f19]/12">
              <h2 className="text-2xl font-display font-bold text-center text-[#522f19]">
                {editingProfile ? 'Editar Perfil' : 'Criar Perfil'}
              </h2>
              <div className="flex flex-col items-center mb-4">
                <div className="w-24 h-24 rounded-full bg-[#f2ebe0] border-2 border-dashed border-[#AF5E33]/50 overflow-hidden mb-2 flex items-center justify-center relative">
                  <img
                    src={newProfilePhoto || DEFAULT_PROFILE_IMAGE}
                    alt="Foto do perfil"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                  <input type="file" accept="image/*" className="absolute inset-0 opacity-0 cursor-pointer" onChange={handleProfilePhotoUpload} />
                </div>
                <p className="text-xs text-[#AF5E33] font-semibold uppercase tracking-wide">Toque para carregar foto</p>
              </div>
              <input
                type="text"
                placeholder="Nome Completo"
                className="w-full p-4 border border-[#522f19]/15 bg-[#f9f5ef] text-[#522f19] rounded-2xl outline-none focus:border-[#AF5E33]"
                value={newProfileName}
                onChange={e => setNewProfileName(e.target.value)}
              />
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-[#522f19]/70 px-1">
                  Data de Nascimento (DD/MM/AAAA)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={10}
                  placeholder="DD/MM/AAAA"
                  className="w-full p-4 border border-[#522f19]/15 bg-[#f9f5ef] text-[#522f19] rounded-2xl outline-none focus:border-[#AF5E33] tabular-nums"
                  value={newProfileBirth}
                  onChange={e => setNewProfileBirth(maskBrDate(e.target.value))}
                />
              </div>
              {(isPatiProfile(editingProfile) || isPatiProfile({ name: newProfileName })) && (
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-[#522f19]/70 px-1 flex items-center justify-between">
                    <span>Senha do Perfil (Opcional)</span>
                    {editingProfile?.passwordHash && !removeProfilePassword && (
                      <span className="text-[11px] font-semibold text-[#AF5E33]">Protegido</span>
                    )}
                  </label>
                  <input
                    type="password"
                    disabled={removeProfilePassword}
                    placeholder={
                      editingProfile?.passwordHash
                        ? 'Nova senha (deixe vazio para manter a atual)'
                        : 'Deixe vazio para entrar sem senha'
                    }
                    className="w-full p-4 border border-[#522f19]/15 bg-[#f9f5ef] text-[#522f19] rounded-2xl outline-none focus:border-[#AF5E33] disabled:opacity-50"
                    value={newProfilePassword}
                    onChange={e => setNewProfilePassword(e.target.value)}
                  />
                  {editingProfile?.passwordHash && (
                    <label className="flex items-center gap-2 text-xs text-[#522f19]/75 px-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={removeProfilePassword}
                        onChange={e => {
                          setRemoveProfilePassword(e.target.checked);
                          if (e.target.checked) setNewProfilePassword('');
                        }}
                        className="accent-[#AF5E33] rounded"
                      />
                      <span>Remover senha deste perfil</span>
                    </label>
                  )}
                </div>
              )}
              <button
                onClick={handleSaveProfile}
                className="w-full py-4 bg-[#AF5E33] hover:bg-[#934c27] text-[#f9f5ef] rounded-full font-semibold shadow-sm transition-colors"
              >
                {editingProfile ? 'Salvar Alterações' : 'Criar Perfil'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    const filteredRecipes = sortedRecipes.filter(r => {
      const searchNorm = normalizeText(search);
      const matchesSearch =
        !searchNorm ||
        normalizeText(r.title).includes(searchNorm) ||
        normalizeText(r.ingredients).includes(searchNorm) ||
        normalizeText(r.authorName).includes(searchNorm);
      const matchesCategory = categoryFilter === 'all' || r.category === categoryFilter;
      const matchesFavorites = categoryFilter === 'favoritos' ? (r.favoritedBy?.includes(activeProfile?.id || '')) : true;
      return matchesSearch && (categoryFilter === 'favoritos' ? matchesFavorites : matchesCategory);
    });

    return (
      <div className="min-h-screen bg-[#f9f5ef] text-[#522f19]">
        <header className="bg-[#fffcf7]/95 backdrop-blur-md px-4 py-3.5 sticky top-0 z-40 border-b border-[#522f19]/12 shadow-[0_4px_20px_-10px_rgba(82,47,25,0.12)]">
          <div className="max-w-6xl mx-auto flex flex-col gap-3">
            <div className="flex justify-between items-center gap-4">
              <div
                className="flex items-center gap-3 cursor-pointer min-w-0"
                onClick={() => { setView(AppView.HOME); setShowBirthdays(false); }}
              >
                <img
                  src={LOGO_URL}
                  alt="Logo"
                  referrerPolicy="no-referrer"
                  className="w-14 h-14 rounded-full border border-white shrink-0 object-cover shadow-sm bg-[#fffcf7]"
                />
                <h1 className="text-xl sm:text-2xl font-display font-bold italic text-[#522f19] truncate">
                  Caderno de receitas da Pati
                </h1>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={() => setView(AppView.PROFILE_SELECT)}
                  title="Trocar perfil"
                  className="rounded-full focus:outline-none"
                >
                  <img
                    src={activeProfile?.photoUrl || DEFAULT_PROFILE_IMAGE}
                    alt={activeProfile?.name || 'Perfil'}
                    referrerPolicy="no-referrer"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_IMAGE; }}
                    className="w-10 h-10 rounded-full border-2 border-[#AF5E33] cursor-pointer object-cover shadow-sm"
                  />
                </button>
              </div>
            </div>

            {view === AppView.HOME && (
              <div ref={searchContainerRef} className="relative w-full">
                <div className="flex gap-2 w-full">
                  <div className="relative flex-1 min-w-0">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#522f19]/45 text-sm pointer-events-none">
                      🔍
                    </span>
                    <input
                      type="text"
                      placeholder="Buscar receita, ingrediente ou quem enviou..."
                      className="w-full py-2.5 pl-10 pr-9 rounded-full border border-[#522f19]/15 focus:border-[#AF5E33] outline-none bg-[#f9f5ef] text-sm text-[#522f19] placeholder:text-[#522f19]/45 transition-colors"
                      value={tempSearch}
                      onFocus={() => setIsSearchFocused(true)}
                      onChange={e => {
                        const val = e.target.value;
                        setTempSearch(val);
                        setSearch(val);
                        setIsSearchFocused(true);
                        if (showBirthdays && val.trim()) {
                          setShowBirthdays(false);
                        }
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          setSearch(tempSearch);
                          setIsSearchFocused(false);
                          setShowBirthdays(false);
                        } else if (e.key === 'Escape') {
                          setIsSearchFocused(false);
                        }
                      }}
                    />
                    {tempSearch && (
                      <button
                        type="button"
                        aria-label="Limpar busca"
                        onClick={() => {
                          setTempSearch('');
                          setSearch('');
                          setIsSearchFocused(false);
                        }}
                        className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-[#522f19]/10 hover:bg-[#522f19]/20 text-[#522f19] text-xs flex items-center justify-center"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setSearch(tempSearch);
                      setIsSearchFocused(false);
                      setShowBirthdays(false);
                    }}
                    className="bg-[#AF5E33] hover:bg-[#934c27] text-[#f9f5ef] px-5 py-2.5 rounded-full font-semibold text-xs uppercase tracking-wider shadow-sm transition-colors whitespace-nowrap shrink-0"
                  >
                    Buscar
                  </button>
                </div>

                {isSearchFocused && tempSearch.trim().length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-2 z-50 bg-[#fffcf7] border border-[#522f19]/15 rounded-2xl shadow-[0_16px_40px_-10px_rgba(82,47,25,0.22)] overflow-hidden">
                    {searchSuggestions.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-[#522f19]/60">
                        Nenhuma receita similar encontrada para "{tempSearch}".
                      </div>
                    ) : (
                      <div className="divide-y divide-[#522f19]/10 max-h-80 overflow-y-auto">
                        {searchSuggestions.map(item => {
                          const catLabel = CATEGORIES.find(c => c.id === item.category)?.label || '';
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => {
                                setEditingRecipe(item);
                                setView(AppView.RECIPE_DETAIL);
                                setShowBirthdays(false);
                                setIsSearchFocused(false);
                              }}
                              className="w-full px-4 py-2.5 flex items-center gap-3 text-left hover:bg-[#f2ebe0] transition-colors"
                            >
                              <img
                                src={item.imageUrl || DEFAULT_RECIPE_IMAGE}
                                alt={item.title}
                                referrerPolicy="no-referrer"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_RECIPE_IMAGE; }}
                                className="w-11 h-11 rounded-xl object-cover shrink-0 border border-[#522f19]/10"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="font-display font-semibold text-[#522f19] text-sm truncate">
                                  {item.title}
                                </p>
                                <p className="text-xs text-[#522f19]/60 truncate">
                                  {catLabel ? `${catLabel} · ` : ''}De: {item.authorName}
                                </p>
                              </div>
                              <span className="text-xs font-semibold text-[#AF5E33] shrink-0">Abrir →</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        <div className="p-4 sm:p-6 max-w-6xl mx-auto flex flex-col md:flex-row gap-6 lg:gap-8">
          {view === AppView.HOME && (
            <aside className="w-full md:w-64 shrink-0 space-y-3">
              <div className="bg-[#fffcf7] p-2.5 rounded-3xl shadow-[0_6px_24px_-10px_rgba(82,47,25,0.12)] border border-[#522f19]/12 overflow-hidden space-y-1.5">
                <button
                  onClick={() => { setCategoryFilter('favoritos'); setIsCategoriesOpen(false); setShowBirthdays(false); }}
                  className={`w-full text-left px-4 py-3 rounded-2xl font-semibold text-sm flex items-center transition-all ${
                    categoryFilter === 'favoritos' && !showBirthdays
                      ? 'bg-[#AF5E33] text-[#f9f5ef] shadow-sm'
                      : 'text-[#522f19] hover:bg-[#f2ebe0]'
                  }`}
                >
                  <span className="truncate">Favoritas de {activeProfile?.name || 'Pati'}</span>
                </button>

                <button
                  onClick={() => { setCategoryFilter('all'); setIsCategoriesOpen(false); setShowBirthdays(false); }}
                  className={`w-full text-left px-4 py-3 rounded-2xl font-semibold text-sm flex items-center transition-all ${
                    categoryFilter === 'all' && !showBirthdays
                      ? 'bg-[#AF5E33] text-[#f9f5ef] shadow-sm'
                      : 'text-[#522f19] hover:bg-[#f2ebe0]'
                  }`}
                >
                  <span>Todas</span>
                </button>

                <button
                  onClick={() => { setShowBirthdays(true); setIsCategoriesOpen(false); }}
                  className={`w-full text-left px-4 py-3 rounded-2xl font-semibold text-sm flex items-center justify-between transition-all ${
                    showBirthdays
                      ? 'bg-[#522f19] text-[#f9f5ef] shadow-sm'
                      : 'text-[#522f19] hover:bg-[#f2ebe0]'
                  }`}
                >
                  <span>Aniversariantes</span>
                  {birthdayProfiles.length > 0 && (
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                      showBirthdays ? 'bg-[#AF5E33] text-[#f9f5ef]' : 'bg-[#AF5E33]/15 text-[#AF5E33]'
                    }`}>
                      {birthdayProfiles.length}
                    </span>
                  )}
                </button>

                <button
                  onClick={() => setIsCategoriesOpen(!isCategoriesOpen)}
                  className={`w-full text-left px-4 py-3 rounded-2xl font-semibold text-sm flex items-center justify-between transition-all ${
                    isCategoriesOpen
                      ? 'bg-[#f2ebe0] text-[#522f19]'
                      : 'text-[#522f19] hover:bg-[#f2ebe0]'
                  }`}
                >
                  <span>Categorias</span>
                  <span className={`text-xs transition-transform duration-300 ${isCategoriesOpen ? 'rotate-180' : ''}`}>▼</span>
                </button>

                <div className={`transition-all duration-300 overflow-hidden ${isCategoriesOpen ? 'max-h-[520px] pt-1 opacity-100' : 'max-h-0 opacity-0'}`}>
                  {CATEGORIES.map(cat => (
                    <button
                      key={cat.id}
                      onClick={() => { setCategoryFilter(cat.id); setIsCategoriesOpen(false); setShowBirthdays(false); }}
                      className={`w-full text-left px-4 py-2 rounded-xl font-medium text-sm transition-all ${
                        categoryFilter === cat.id && !showBirthdays
                          ? 'text-[#f9f5ef] bg-[#AF5E33] font-semibold'
                          : 'text-[#522f19]/80 hover:bg-[#f2ebe0]'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              <a
                href={WHATSAPP_GROUP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full px-4 py-3.5 rounded-2xl font-semibold text-sm text-[#2d6a4f] bg-[#edf4ef] border border-[#2d6a4f]/15 flex items-center justify-center shadow-sm hover:bg-[#e1ede4] transition-colors"
              >
                Grupo da Família
              </a>
            </aside>
          )}

          <main className="flex-1 min-w-0">
            {view === AppView.HOME && showBirthdays && (
              <div className="bg-[#fffcf7] rounded-3xl p-8 border border-[#522f19]/12 shadow-[0_6px_24px_-10px_rgba(82,47,25,0.12)] fade-in">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-6 pb-4 border-b border-[#522f19]/10">
                  <div className="flex items-center gap-3">
                    <span className="text-4xl">🎂</span>
                    <div>
                      <h2 className="text-2xl sm:text-3xl font-display font-bold text-[#522f19]">
                        Aniversariantes de {currentMonthName}
                      </h2>
                      <p className="text-xs text-[#522f19]/60 mt-0.5">
                        Quem da família sopra velinhas neste mês
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowBirthdays(false)}
                    className="text-xs font-semibold text-[#AF5E33] hover:underline"
                  >
                    ← Voltar para receitas
                  </button>
                </div>

                {birthdayProfiles.length === 0 ? (
                  <div className="py-12 text-center space-y-3">
                    <p className="text-[#522f19]/60 italic text-base">
                      Ninguém soprando velinhas neste mês...
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                    {birthdayProfiles.map(p => {
                      const birthDay = p.birthDate.split('-')[2];
                      return (
                        <div
                          key={p.id}
                          className="flex items-center gap-4 bg-[#f9f5ef] p-4 rounded-2xl border border-[#522f19]/12"
                        >
                          <img
                            src={p.photoUrl || DEFAULT_PROFILE_IMAGE}
                            alt={p.name}
                            referrerPolicy="no-referrer"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_IMAGE; }}
                            className="w-16 h-16 rounded-full border-2 border-[#AF5E33] shadow-sm object-cover shrink-0"
                          />
                          <div className="min-w-0">
                            <p className="font-display font-bold text-[#522f19] text-lg truncate">
                              {p.name}
                            </p>
                            <p className="text-xs font-semibold text-[#AF5E33] uppercase tracking-wider mt-0.5">
                              Dia {birthDay} de {currentMonthName}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {view === AppView.HOME && !showBirthdays && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-7">
                {filteredRecipes.length === 0 ? (
                  <div className="col-span-full text-center py-24 text-[#522f19]/60 font-display italic text-lg">
                    Poxa, nenhuma receita encontrada aqui! Cozinhe algo novo!
                  </div>
                ) : (
                  filteredRecipes.map(recipe => {
                    const author = profiles.find(p => p.id === recipe.authorId);
                    const isFavoritedByMe = recipe.favoritedBy?.includes(activeProfile?.id || '');
                    const categoryLabel = CATEGORIES.find(c => c.id === recipe.category)?.label;
                    const snippetSource = recipe.ingredients
                      ? recipe.ingredients.replace(/\s*\n+\s*/g, ', ').trim()
                      : (recipe.tips || recipe.instructions || 'Receita especial da família');

                    return (
                      <div
                        key={recipe.id}
                        onClick={() => { setEditingRecipe(recipe); setView(AppView.RECIPE_DETAIL); }}
                        className="group bg-[#fffcf7] rounded-[28px] p-3.5 border border-[#522f19]/12 shadow-[0_6px_24px_-8px_rgba(82,47,25,0.10)] hover:shadow-[0_14px_32px_-10px_rgba(82,47,25,0.18)] hover:-translate-y-0.5 transition-all duration-300 cursor-pointer flex flex-col"
                      >
                        <div className="relative bg-[#f2ebe0] rounded-[22px] p-2.5 mb-4">
                          <div className="relative aspect-[4/3] overflow-hidden rounded-[18px] shadow-[0_8px_18px_-6px_rgba(82,47,25,0.28)] transform -rotate-1 group-hover:rotate-0 transition-transform duration-300 bg-[#e8dfd2]">
                            <img
                              src={recipe.imageUrl || DEFAULT_RECIPE_IMAGE}
                              alt={recipe.title}
                              referrerPolicy="no-referrer"
                              onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_RECIPE_IMAGE; }}
                              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                            />
                          </div>
                          <div className="absolute top-4 right-4 flex flex-col gap-2 z-10">
                            <button
                              type="button"
                              aria-label={isFavoritedByMe ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
                              onClick={(e) => { e.stopPropagation(); toggleFavorite(recipe.id); }}
                              className={`w-9 h-9 rounded-full bg-[#fffcf7]/95 backdrop-blur-sm border border-[#522f19]/10 shadow-sm flex items-center justify-center text-base transition-transform hover:scale-110 ${
                                isFavoritedByMe ? 'opacity-100' : 'opacity-75 hover:opacity-100'
                              }`}
                            >
                              {isFavoritedByMe ? '❤️' : '🤍'}
                            </button>
                            {recipe.externalLink && (
                              <div
                                className="w-9 h-9 rounded-full bg-[#AF5E33] text-[#f9f5ef] shadow-sm flex items-center justify-center text-xs"
                                title="Possui link externo"
                              >
                                🔗
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="px-2 pb-1 flex-1 flex flex-col">
                          <h3 className="font-display font-bold text-[#522f19] text-xl leading-snug mb-2 group-hover:text-[#AF5E33] transition-colors line-clamp-2">
                            {recipe.title}
                          </h3>
                          <p className="text-sm text-[#522f19]/75 leading-relaxed line-clamp-2 mb-3">
                            {snippetSource}
                          </p>
                          <div className="mb-4">
                            <span className="text-xs font-semibold uppercase tracking-wider text-[#AF5E33] underline underline-offset-4 decoration-[#AF5E33]/60 group-hover:decoration-[#AF5E33]">
                              Ver detalhes
                            </span>
                          </div>

                          <div className="mt-auto pt-3.5 border-t border-[#522f19]/10 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                              <img
                                src={author?.photoUrl || DEFAULT_PROFILE_IMAGE}
                                alt={recipe.authorName}
                                referrerPolicy="no-referrer"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_IMAGE; }}
                                className="w-7 h-7 rounded-full object-cover border border-[#522f19]/15 shrink-0"
                              />
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-[#522f19] truncate">
                                  De: {recipe.authorName}
                                </p>
                                {categoryLabel && (
                                  <p className="text-[11px] text-[#522f19]/60 truncate">
                                    {categoryLabel}
                                  </p>
                                )}
                              </div>
                            </div>
                            <span className="shrink-0 inline-flex items-center bg-[#AF5E33] group-hover:bg-[#934c27] text-[#f9f5ef] px-4 py-2 rounded-full text-xs font-semibold shadow-sm transition-colors whitespace-nowrap">
                              Ver receita
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {view === AppView.RECIPE_DETAIL && currentDetailRecipe && (
              <RecipeDetailView
                recipe={currentDetailRecipe}
                activeProfile={activeProfile}
                canManage={isRecipeAuthor(currentDetailRecipe, activeProfile)}
                onBack={() => setView(AppView.HOME)}
                onEdit={() => { setEditingRecipe(currentDetailRecipe); setView(AppView.RECIPE_EDIT); }}
                onDelete={() => deleteRecipe(currentDetailRecipe.id)}
                onToggleFavorite={() => toggleFavorite(currentDetailRecipe.id)}
                onAddComment={(t: string) => addComment(currentDetailRecipe.id, t)}
                onWhatsAppShare={() => handleWhatsAppShare(currentDetailRecipe.title)}
              />
            )}

            {(view === AppView.RECIPE_EDIT || view === AppView.AI_TOOLS) && (
              <RecipeForm
                recipe={editingRecipe || undefined}
                activeProfile={activeProfile}
                onSave={saveRecipe}
                onCancel={() => setView(AppView.HOME)}
                isAiLoading={isAiLoading}
                setIsAiLoading={setIsAiLoading}
              />
            )}
          </main>
        </div>

        {view === AppView.HOME && (
          <button
            onClick={() => { setEditingRecipe(null); setView(AppView.RECIPE_EDIT); }}
            title="Adicionar nova receita"
            className="fixed bottom-8 right-8 w-16 h-16 bg-[#AF5E33] hover:bg-[#934c27] text-[#f9f5ef] text-3xl rounded-full shadow-2xl flex items-center justify-center z-50 hover:scale-110 active:scale-95 transition-all"
          >
            +
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#f9f5ef] text-[#522f19]">
      <div className="flex-grow">{renderContent()}</div>
      <Footer />
    </div>
  );
};

const RecipeDetailView = ({
  recipe,
  activeProfile,
  canManage,
  onBack,
  onEdit,
  onDelete,
  onToggleFavorite,
  onAddComment,
  onWhatsAppShare
}: any) => {
  const [portionFactor, setPortionFactor] = useState(1);
  const [adjustedIngredients, setAdjustedIngredients] = useState(recipe.ingredients);
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setAdjustedIngredients(recipe.ingredients);
    setPortionFactor(1);
    setCopied(false);
  }, [recipe.id, recipe.ingredients]);

  const handleAdjust = async (val: number) => {
    setPortionFactor(val);
    setIsAdjusting(true);
    try {
      const adjusted = await gemini.adjustPortions(recipe.ingredients, val);
      setAdjustedIngredients(adjusted);
    } catch (err: any) {
      alert(err?.message || "Não foi possível ajustar as porções automaticamente por IA no momento.");
    } finally {
      setIsAdjusting(false);
    }
  };

  const isFavoritedByMe = recipe.favoritedBy?.includes(activeProfile?.id || '');
  const categoryLabel = CATEGORIES.find(c => c.id === recipe.category)?.label;
  const ingredientLines = formatIngredientsLines(adjustedIngredients);
  const instructionSteps = formatInstructionSteps(recipe.instructions);

  const handleCopyRecipe = async () => {
    const sections: string[] = [];
    sections.push(recipe.title);
    const meta = [categoryLabel, recipe.authorName ? `Por ${recipe.authorName}` : ''].filter(Boolean).join(' · ');
    if (meta) sections.push(meta);
    if (ingredientLines.length > 0) {
      sections.push(`\nIngredientes${portionFactor !== 1 ? ` (${portionFactor}x)` : ''}:\n${ingredientLines.map(item => `• ${item}`).join('\n')}`);
    }
    if (instructionSteps.length > 0) {
      sections.push(`\nModo de Preparo:\n${instructionSteps.join('\n')}`);
    }
    if (recipe.tips) {
      sections.push(`\nDica da ${recipe.authorName || 'Cozinha'}:\n${recipe.tips}`);
    }
    if (recipe.externalLink) {
      sections.push(`\nLink original: ${recipe.externalLink}`);
    }
    const textToCopy = sections.join('\n');

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(textToCopy);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = textToCopy;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = textToCopy;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div className="bg-[#fffcf7] rounded-3xl p-6 sm:p-8 shadow-[0_10px_30px_-12px_rgba(82,47,25,0.14)] max-w-3xl mx-auto border border-[#522f19]/12 space-y-8 fade-in">
      <div className="flex justify-between items-center gap-3">
        <button onClick={onBack} className="text-[#AF5E33] font-semibold flex items-center gap-2 hover:underline">
          ← Voltar
        </button>
        <div className="flex gap-3 sm:gap-4 items-center">
          <button
            type="button"
            onClick={handleCopyRecipe}
            title="Copiar receita completa"
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all active:scale-95 ${
              copied
                ? 'bg-[#2d6a4f] text-[#f9f5ef] border-[#2d6a4f]'
                : 'bg-[#f9f5ef] text-[#522f19] border-[#522f19]/15 hover:border-[#AF5E33] hover:text-[#AF5E33]'
            }`}
          >
            {copied ? (
              <>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                <span>Copiada!</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
                </svg>
                <span>Copiar</span>
              </>
            )}
          </button>
          <button onClick={onWhatsAppShare} title="Compartilhar no WhatsApp" className="text-[#2d6a4f] hover:scale-110 transition-transform">
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 448 512"><path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-5.5-2.8-23.4-8.6-44.6-27.6-16.5-14.7-27.6-32.8-30.8-38.4-3.2-5.6-.3-8.6 2.5-11.4 2.5-2.5 5.5-6.5 8.3-9.8 2.8-3.2 3.7-5.5 5.5-9.2 1.9-3.7.9-7-.5-9.8-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 13.2 5.8 23.5 9.2 31.5 11.8 13.3 4.2 25.4 3.6 35 2.2 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z"/></svg>
          </button>
          <button onClick={onToggleFavorite} className="text-2xl transition-transform active:scale-125">
            {isFavoritedByMe ? '❤️' : '🤍'}
          </button>
          {canManage && (
            <>
              <button onClick={onEdit} title="Editar receita" className="text-xl hover:scale-110 transition-transform">✏️</button>
              <button onClick={onDelete} title="Excluir receita" className="text-xl hover:scale-110 transition-transform">🗑️</button>
            </>
          )}
        </div>
      </div>

      <div className="bg-[#f2ebe0] rounded-3xl p-3">
        <div className="relative group overflow-hidden rounded-2xl shadow-md">
          <img
            src={recipe.imageUrl || DEFAULT_RECIPE_IMAGE}
            alt={recipe.title}
            referrerPolicy="no-referrer"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_RECIPE_IMAGE; }}
            className="w-full h-80 object-cover transition-transform duration-700 group-hover:scale-105"
          />
          {canManage && (
            <button
              onClick={onEdit}
              className="absolute bottom-4 right-4 bg-[#fffcf7]/95 backdrop-blur-sm text-[#522f19] px-5 py-2.5 rounded-full font-semibold text-xs shadow-lg opacity-0 group-hover:opacity-100 transition-all active:scale-95"
            >
              Alterar Imagem da Receita
            </button>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-3xl sm:text-4xl font-display font-bold text-[#522f19] mb-2">
          {recipe.title}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[#522f19]/70 mb-3">
          {categoryLabel && <span className="font-semibold text-[#AF5E33]">{categoryLabel}</span>}
          {categoryLabel && <span>·</span>}
          <span>Por {recipe.authorName}</span>
          {recipe.source && (
            <>
              <span>·</span>
              <span className="italic">Origem: {recipe.source}</span>
            </>
          )}
        </div>
        {recipe.externalLink && (
          <a
            href={recipe.externalLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#AF5E33] underline underline-offset-4 hover:text-[#522f19]"
          >
            🔗 Ver Link Original
          </a>
        )}
      </div>

      <div className="bg-[#f9f5ef] p-6 rounded-2xl border border-[#522f19]/12">
        <div className="flex justify-between items-center mb-4">
          <h4 className="font-display font-bold text-[#522f19] text-lg flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-[#f2ebe0] text-[#522f19] inline-flex items-center justify-center shrink-0">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M4 6h2v2H4V6zm0 5h2v2H4v-2zm0 5h2v2H4v-2zm4-9h12v2H8V7zm0 5h12v2H8v-2zm0 5h12v2H8v-2z" />
              </svg>
            </span>
            <span>Ingredientes</span>
          </h4>
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => handleAdjust(Math.max(0.5, portionFactor - 0.5))}
              className="w-8 h-8 rounded-full bg-[#fffcf7] border border-[#522f19]/15 text-[#AF5E33] shadow-sm flex items-center justify-center font-bold transition-transform active:scale-90"
            >
              -
            </button>
            <span className="font-semibold text-sm text-[#522f19] tabular-nums">{portionFactor}x</span>
            <button
              onClick={() => handleAdjust(portionFactor + 0.5)}
              className="w-8 h-8 rounded-full bg-[#fffcf7] border border-[#522f19]/15 text-[#AF5E33] shadow-sm flex items-center justify-center font-bold transition-transform active:scale-90"
            >
              +
            </button>
          </div>
        </div>
        {ingredientLines.length > 0 ? (
          <ul className={`space-y-2 text-[#522f19]/90 text-sm leading-relaxed ${isAdjusting ? 'opacity-30' : ''}`}>
            {ingredientLines.map((item, idx) => (
              <li key={idx} className="flex items-start gap-2.5">
                <span className="text-[#AF5E33] font-bold leading-relaxed select-none">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[#522f19]/60 italic">Nenhum ingrediente informado.</p>
        )}
      </div>

      <div className="space-y-6">
        <div className="space-y-4">
          <h4 className="font-display font-bold text-[#522f19] text-lg flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-[#f2ebe0] text-[#522f19] inline-flex items-center justify-center shrink-0">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8.1 13.34l2.83-2.83L3.91 3.5a4.008 4.008 0 000 5.66l4.19 4.18zm6.78-1.81c1.53.71 3.68.21 5.27-1.38 1.91-1.91 2.28-4.65.81-6.12-1.46-1.46-4.2-1.1-6.12.81-1.59 1.59-2.09 3.74-1.38 5.27L3.7 19.87l1.41 1.41L12 14.41l6.88 6.88 1.41-1.41L13.41 13l1.47-1.47z" />
              </svg>
            </span>
            <span>Modo de Preparo</span>
          </h4>
          {instructionSteps.length > 0 ? (
            <div className="space-y-3">
              {instructionSteps.map((step, idx) => {
                const match = step.match(/^(\d+[.)])\s*(.*)$/);
                return (
                  <div key={idx} className="text-[#522f19]/90 leading-relaxed text-sm flex items-start gap-2.5">
                    {match ? (
                      <>
                        <span className="font-bold text-[#AF5E33] shrink-0 tabular-nums">{match[1]}</span>
                        <span>{match[2]}</span>
                      </>
                    ) : (
                      <span>{step}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-[#522f19]/60 italic">Modo de preparo não informado.</p>
          )}
        </div>

        {recipe.tips && (
          <div className="p-6 bg-[#f2ebe0] rounded-2xl border border-[#AF5E33]/20 space-y-2 fade-in">
            <h4 className="font-semibold text-[#AF5E33] text-xs uppercase tracking-[0.15em] flex items-center gap-2">
              💡 Dica da {recipe.authorName}
            </h4>
            <p className="text-[#522f19]/85 text-sm italic leading-relaxed">{recipe.tips}</p>
          </div>
        )}
      </div>

      <div className="pt-8 border-t border-[#522f19]/10">
        <h4 className="font-display font-bold text-[#522f19] text-lg mb-4">💬 Comentários</h4>
        <div className="space-y-3 mb-6">
          {(recipe.comments || []).map((c: any) => (
            <div key={c.id} className="bg-[#f9f5ef] p-4 rounded-2xl border border-[#522f19]/10 fade-in">
              <p className="text-xs font-bold text-[#AF5E33] mb-1">{c.authorName}</p>
              <p className="text-sm text-[#522f19]/85">{c.text}</p>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Escreva um comentário..."
            className="flex-1 p-3 px-4 border border-[#522f19]/15 bg-[#f9f5ef] text-[#522f19] rounded-full text-sm outline-none focus:border-[#AF5E33] transition-all"
            value={commentText}
            onChange={e => setCommentText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (onAddComment(commentText), setCommentText(''))}
          />
          <button
            onClick={() => { onAddComment(commentText); setCommentText(''); }}
            className="bg-[#AF5E33] hover:bg-[#934c27] text-[#f9f5ef] px-6 rounded-full font-semibold text-xs uppercase tracking-wider shadow-sm transition-all active:scale-95"
          >
            Enviar
          </button>
        </div>
      </div>
    </div>
  );
};

const RecipeForm = ({ recipe, activeProfile, onSave, onCancel, isAiLoading, setIsAiLoading }: any) => {
  const [step, setStep] = useState(recipe ? 'form' : 'options');
  const initialData = recipe || {
    title: '',
    category: 'outros' as any,
    ingredients: '',
    instructions: '',
    tips: '',
    source: '',
    authorName: activeProfile?.name || ''
  };
  const [formData, setFormData] = useState<Partial<Recipe>>(initialData);
  const [videoUrl, setVideoUrl] = useState('');
  const [suggestionInput, setSuggestionInput] = useState('');
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraFallbackInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [step]);

  const stopCameraStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, []);

  useEffect(() => {
    if (isCameraOpen && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [isCameraOpen]);

  const handleSimpleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      const reader = new FileReader();
      reader.onloadend = async () => {
        try {
          const compressed = await compressImage(reader.result as string, 800, 0.75);
          setFormData(prev => ({ ...prev, imageUrl: compressed }));
        } catch (err: any) {
          alert(err?.message || 'Não foi possível carregar esta imagem.');
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const processScannedImageDataUrl = async (rawDataUrl: string) => {
    setIsAiLoading(true);
    let compressed = rawDataUrl;
    try {
      compressed = await compressImage(rawDataUrl, 1200, 0.85);
      const [header, base64Data] = compressed.split(',');
      const mimeMatch = header?.match(/data:(.*?);base64/);
      const mimeType = mimeMatch?.[1] || 'image/jpeg';
      if (!base64Data) {
        throw new Error('Imagem inválida para leitura.');
      }
      const result = await gemini.transcribeImage(base64Data, mimeType);
      setFormData(prev => ({ ...prev, ...result, imageUrl: compressed }));
      setStep('form');
    } catch (err: any) {
      alert(err?.message || 'Não foi possível transcrever automaticamente por IA. Você pode preencher os dados da receita manualmente.');
      setFormData(prev => ({ ...prev, imageUrl: compressed }));
      setStep('form');
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = async () => {
      if (typeof reader.result === 'string') {
        await processScannedImageDataUrl(reader.result);
      } else {
        alert('Não foi possível ler o arquivo de imagem selecionado.');
      }
    };
    reader.onerror = () => {
      alert('Erro ao abrir o arquivo de imagem.');
    };
    reader.readAsDataURL(file);
  };

  const handleOpenCamera = async () => {
    setCameraError('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraFallbackInputRef.current?.click();
      return;
    }

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }
      streamRef.current = stream;
      setIsCameraOpen(true);
    } catch {
      cameraFallbackInputRef.current?.click();
    }
  };

  const handleCapturePhoto = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setCameraError('Aguarde a câmera carregar antes de tirar a foto.');
      return;
    }
    const canvas = document.createElement('canvas');
    const maxWidth = 1200;
    let width = video.videoWidth;
    let height = video.videoHeight;
    if (width > maxWidth) {
      height = Math.round(height * (maxWidth / width));
      width = maxWidth;
    }
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    stopCameraStream();
    setIsCameraOpen(false);
    await processScannedImageDataUrl(dataUrl);
  };

  const handleCloseCamera = () => {
    stopCameraStream();
    setIsCameraOpen(false);
    setCameraError('');
  };

  const handleVideoTranscribe = async () => {
    if (!videoUrl) return;
    setIsAiLoading(true);
    try {
      const result = await gemini.transcribeVideoLink(videoUrl);
      setFormData(prev => ({ ...prev, ...result, externalLink: videoUrl }));
      setStep('form');
    } catch (err: any) {
      alert(err?.message || 'Não foi possível transcrever o vídeo pela IA. O link foi salvo e você pode preencher a receita manualmente.');
      setFormData(prev => ({ ...prev, externalLink: videoUrl }));
      setStep('form');
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleSuggestion = async () => {
    if (!suggestionInput) return;
    setIsAiLoading(true);
    try {
      const result = await gemini.getRecipeSuggestions(suggestionInput);
      setFormData(prev => ({ ...prev, ...result }));
      setStep('form');
    } catch (err: any) {
      alert(err?.message || 'Não foi possível gerar sugestão por IA no momento.');
    } finally {
      setIsAiLoading(false);
    }
  };

  if (step === 'options') {
    return (
      <div className="bg-[#fffcf7] rounded-3xl p-8 shadow-[0_10px_30px_-12px_rgba(82,47,25,0.14)] max-w-lg mx-auto space-y-6 border border-[#522f19]/12 fade-in">
        <h2 className="text-2xl font-display font-bold text-[#522f19]">Nova Receita</h2>
        <div className="space-y-4">
          <div className="p-6 border-2 border-dashed border-[#AF5E33]/35 bg-[#f9f5ef] rounded-3xl text-center space-y-4">
            <div>
              <div className="w-12 h-12 rounded-2xl bg-[#f2ebe0] text-[#522f19] mx-auto mb-3 flex items-center justify-center">
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                </svg>
              </div>
              <span className="text-[#522f19] font-semibold block">Foto / Scanner com IA</span>
              <p className="text-xs text-[#522f19]/70 mt-1.5 leading-relaxed max-w-sm mx-auto">
                Tire uma foto na hora ou envie uma imagem de receita impressa ou escrita à mão. A IA lê a imagem e preenche os campos automaticamente.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleOpenCamera}
                className="flex-1 py-3 bg-[#AF5E33] hover:bg-[#934c27] text-[#f9f5ef] rounded-full font-semibold text-xs uppercase tracking-wider transition-all active:scale-95"
              >
                Abrir Câmera
              </button>
              <button
                type="button"
                onClick={() => galleryInputRef.current?.click()}
                className="flex-1 py-3 bg-[#f2ebe0] hover:bg-[#e7ddd0] text-[#522f19] rounded-full font-semibold text-xs uppercase tracking-wider transition-all active:scale-95"
              >
                Enviar Imagem
              </button>
            </div>
            <input
              ref={cameraFallbackInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleImageUpload}
            />
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
            />
          </div>
          <div className="p-6 border-2 border-dashed border-[#AF5E33]/35 bg-[#f9f5ef] rounded-3xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#f2ebe0] text-[#522f19] shrink-0 flex items-center justify-center">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z" />
                </svg>
              </div>
              <div>
                <span className="text-[#522f19] font-semibold block">Link Externo</span>
                <p className="text-xs text-[#522f19]/70 mt-1 leading-relaxed">
                  Cole o endereço de um vídeo ou post. Escolha "IA Extrair" para capturar a receita automaticamente ou "Só Link" para salvar apenas a referência.
                </p>
              </div>
            </div>
            <input
              type="text"
              placeholder="Link do vídeo ou post..."
              className="w-full p-3 border border-[#522f19]/15 bg-[#fffcf7] text-[#522f19] rounded-xl text-sm outline-none focus:border-[#AF5E33]"
              value={videoUrl}
              onChange={e => setVideoUrl(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                onClick={handleVideoTranscribe}
                className="flex-1 py-3 bg-[#AF5E33] hover:bg-[#934c27] text-[#f9f5ef] rounded-full font-semibold text-xs uppercase tracking-wider transition-all active:scale-95"
              >
                IA Extrair
              </button>
              <button
                onClick={() => { setFormData({ ...formData, externalLink: videoUrl }); setStep('form'); }}
                className="flex-1 py-3 bg-[#f2ebe0] hover:bg-[#e7ddd0] text-[#522f19] rounded-full font-semibold text-xs uppercase tracking-wider transition-all active:scale-95"
              >
                Só Link
              </button>
            </div>
          </div>
          <button
            onClick={() => setStep('form')}
            className="w-full p-6 border-2 border-dashed border-[#AF5E33]/35 bg-[#f9f5ef] rounded-3xl hover:bg-[#f2ebe0] text-center flex flex-col items-center transition-all active:scale-95"
          >
            <div className="w-12 h-12 rounded-2xl bg-[#f2ebe0] text-[#522f19] mb-3 flex items-center justify-center">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 000-1.42l-2.34-2.34a1.003 1.003 0 00-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z" />
              </svg>
            </div>
            <span className="text-[#522f19] font-semibold">Digitar Receita Manualmente</span>
            <p className="text-xs text-[#522f19]/70 mt-1.5 leading-relaxed max-w-sm">
              Ideal para receitas de família que você já conhece: preencha título, ingredientes, passo a passo e foto do seu jeito.
            </p>
          </button>
          <div className="p-6 border-2 border-dashed border-[#AF5E33]/35 bg-[#f9f5ef] rounded-3xl space-y-4 text-center">
            <div className="w-12 h-12 rounded-2xl bg-[#f2ebe0] text-[#522f19] mx-auto flex items-center justify-center">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8.1 13.34l2.83-2.83L3.91 3.5a4.008 4.008 0 000 5.66l4.19 4.18zm6.78-1.81c1.53.71 3.68.21 5.27-1.38 1.91-1.91 2.28-4.65.81-6.12-1.46-1.46-4.2-1.1-6.12.81-1.59 1.59-2.09 3.74-1.38 5.27L3.7 19.87l1.41 1.41L12 14.41l6.88 6.88 1.41-1.41L13.41 13l1.47-1.47z" />
              </svg>
            </div>
            <div>
              <span className="text-[#522f19] font-semibold block">O que cozinhar?</span>
              <p className="text-xs text-[#522f19]/70 mt-1.5 leading-relaxed max-w-sm mx-auto">
                Digite os ingredientes que tem em casa separados por vírgula e toque em "Sugestão IA" para criar uma receita completa na hora.
              </p>
            </div>
            <input
              type="text"
              placeholder="Ex: frango, batata, creme de leite..."
              className="w-full p-3 border border-[#522f19]/15 bg-[#fffcf7] text-[#522f19] rounded-xl text-xs outline-none focus:border-[#AF5E33]"
              value={suggestionInput}
              onChange={e => setSuggestionInput(e.target.value)}
            />
            <button
              onClick={handleSuggestion}
              className="w-full py-2.5 bg-[#AF5E33] hover:bg-[#934c27] text-[#f9f5ef] text-xs rounded-full font-semibold uppercase tracking-wider transition-all active:scale-95"
            >
              Sugestão IA
            </button>
          </div>
        </div>
        <button onClick={onCancel} className="w-full py-3 text-[#522f19]/60 font-semibold hover:text-[#522f19]">
          Cancelar
        </button>
        {isCameraOpen && (
          <div className="fixed inset-0 bg-[#522f19]/80 backdrop-blur-sm flex items-center justify-center p-4 z-[100]">
            <div className="bg-[#fffcf7] rounded-3xl p-6 max-w-md w-full space-y-4 shadow-2xl border border-[#522f19]/15">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-display font-bold text-[#522f19]">Fotografar Receita</h3>
                <button
                  type="button"
                  onClick={handleCloseCamera}
                  className="text-xs font-semibold text-[#522f19]/60 hover:text-[#522f19]"
                >
                  Fechar ✕
                </button>
              </div>
              <div className="relative rounded-2xl overflow-hidden bg-[#522f19] aspect-[4/3]">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
              </div>
              {cameraError && (
                <p className="text-xs text-red-600 text-center font-medium">{cameraError}</p>
              )}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleCloseCamera}
                  className="flex-1 py-3 bg-[#f2ebe0] hover:bg-[#e7ddd0] text-[#522f19] rounded-full font-semibold text-xs uppercase tracking-wider transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleCapturePhoto}
                  className="flex-[2] py-3 bg-[#AF5E33] hover:bg-[#934c27] text-[#f9f5ef] rounded-full font-semibold text-xs uppercase tracking-wider shadow-md transition-all active:scale-95"
                >
                  Tirar Foto e Ler Receita
                </button>
              </div>
            </div>
          </div>
        )}
        {isAiLoading && (
          <div className="fixed inset-0 bg-[#f9f5ef]/85 backdrop-blur-sm flex items-center justify-center z-[100] font-display italic text-2xl text-[#AF5E33] animate-pulse">
            A IA está preparando...
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-[#fffcf7] rounded-3xl p-8 shadow-[0_10px_30px_-12px_rgba(82,47,25,0.14)] space-y-6 border border-[#522f19]/12 max-w-3xl mx-auto fade-in">
      <h2 className="text-2xl font-display font-bold text-[#522f19]">
        {recipe ? 'Editar' : 'Nova'} Receita
      </h2>

      <div className="space-y-2">
        <label className="text-xs font-semibold text-[#522f19]/60 uppercase tracking-widest">
          Imagem da Receita
        </label>
        <div className="relative group h-48 rounded-2xl overflow-hidden bg-[#f2ebe0] border border-[#522f19]/12">
          <img
            src={formData.imageUrl || DEFAULT_RECIPE_IMAGE}
            alt="Prévia da receita"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
          <label className="absolute inset-0 bg-[#522f19]/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer text-[#f9f5ef] font-semibold text-xs uppercase tracking-widest">
            Alterar Foto
            <input type="file" accept="image/*" className="hidden" onChange={handleSimpleImageUpload} />
          </label>
        </div>
      </div>

      <div className="space-y-4">
        <input
          type="text"
          placeholder="Título da Receita"
          className="w-full p-4 border border-[#522f19]/15 bg-[#f9f5ef] text-[#522f19] rounded-2xl outline-none focus:border-[#AF5E33]"
          value={formData.title}
          onChange={e => setFormData({ ...formData, title: e.target.value })}
        />
        <select
          className="w-full p-4 border border-[#522f19]/15 bg-[#f9f5ef] text-[#522f19] rounded-2xl outline-none focus:border-[#AF5E33]"
          value={formData.category}
          onChange={e => setFormData({ ...formData, category: e.target.value as any })}
        >
          {CATEGORIES.map(c => (
            <option key={c.id} value={c.id}>{c.icon} {c.label}</option>
          ))}
        </select>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <input
            type="text"
            placeholder="Nome do autor (ex: Seu nome)"
            className="w-full p-4 border border-[#522f19]/15 bg-[#f9f5ef] text-[#522f19] rounded-2xl outline-none focus:border-[#AF5E33]"
            value={formData.authorName}
            onChange={e => setFormData({ ...formData, authorName: e.target.value })}
          />
          <input
            type="text"
            placeholder="Origem (ex: Da Vovó, Inventada...)"
            className="w-full p-4 border border-[#522f19]/15 bg-[#f9f5ef] text-[#522f19] rounded-2xl outline-none focus:border-[#AF5E33]"
            value={formData.source}
            onChange={e => setFormData({ ...formData, source: e.target.value })}
          />
        </div>
        <textarea
          placeholder="Dicas da receita (ex: 'O segredo é deixar a massa descansar 20 min')"
          className="w-full p-4 border border-[#522f19]/15 bg-[#f9f5ef] text-[#522f19] rounded-2xl h-24 outline-none focus:border-[#AF5E33] resize-none"
          value={formData.tips}
          onChange={e => setFormData({ ...formData, tips: e.target.value })}
        />
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <label className="text-xs font-semibold text-[#522f19]/70 uppercase tracking-wider">
              Ingredientes (um por linha)
            </label>
            <button
              type="button"
              onClick={() =>
                setFormData({
                  ...formData,
                  ingredients: formatIngredientsLines(formData.ingredients || '').join('\n')
                })
              }
              className="text-xs font-semibold text-[#AF5E33] hover:underline"
            >
              Organizar linha por linha
            </button>
          </div>
          <textarea
            placeholder={"Digite um ingrediente por linha:\n2 ovos\n1 xícara de farinha de trigo\n1 colher (sopa) de fermento"}
            className="w-full p-4 border border-[#522f19]/15 bg-[#f9f5ef] text-[#522f19] rounded-2xl h-44 outline-none focus:border-[#AF5E33] resize-y leading-relaxed"
            value={formData.ingredients}
            onChange={e => setFormData({ ...formData, ingredients: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <label className="text-xs font-semibold text-[#522f19]/70 uppercase tracking-wider">
              Modo de Preparo (um passo por linha)
            </label>
            <button
              type="button"
              onClick={() =>
                setFormData({
                  ...formData,
                  instructions: formatInstructionSteps(formData.instructions || '').join('\n')
                })
              }
              className="text-xs font-semibold text-[#AF5E33] hover:underline"
            >
              Separar passos por linha
            </button>
          </div>
          <textarea
            placeholder={"Digite um passo por linha:\n1. Bata os ovos com o açúcar.\n2. Adicione a farinha aos poucos.\n3. Asse por 35 minutos a 180°C."}
            className="w-full p-4 border border-[#522f19]/15 bg-[#f9f5ef] text-[#522f19] rounded-2xl h-60 outline-none focus:border-[#AF5E33] resize-y leading-relaxed"
            value={formData.instructions}
            onChange={e => setFormData({ ...formData, instructions: e.target.value })}
          />
        </div>

        <div className="flex flex-col gap-4 pt-4">
          <div className="flex gap-4">
            <button
              onClick={recipe ? onCancel : () => setStep('options')}
              className="flex-1 py-4 border border-[#522f19]/20 rounded-full font-semibold text-[#522f19]/70 transition-all hover:bg-[#f2ebe0]"
            >
              Voltar
            </button>
            <button
              onClick={() => onSave(formData)}
              className="flex-[2] py-4 bg-[#AF5E33] hover:bg-[#934c27] text-[#f9f5ef] rounded-full font-semibold shadow-md transition-all"
            >
              Salvar no Meu Caderno
            </button>
          </div>

          {suggestionInput && !recipe && (
            <button
              onClick={handleSuggestion}
              className="w-full py-4 border-2 border-[#AF5E33] text-[#AF5E33] rounded-full font-semibold transition-all hover:bg-[#AF5E33]/10 flex items-center justify-center gap-2"
            >
              🔄 Não gostou? Gerar Outra Opção
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;
