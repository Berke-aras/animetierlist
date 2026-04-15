import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { getDatabase, ref, onValue, onDisconnect, update } from 'firebase/database';
import { Users, MousePointer2, X, Timer } from 'lucide-react';

// --- FİREBASE BAŞLATMA ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

// Yapılandırma kontrolü
const requiredKeys = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'];
const missingKeys = requiredKeys.filter(key => !firebaseConfig[key] || firebaseConfig[key].includes("YOUR_"));

const ConfigurationError = () => (
  <div className="flex h-screen items-center justify-center bg-zinc-950 text-white p-6 font-sans">
    <div className="bg-zinc-900 p-8 rounded-2xl border-2 border-red-500/50 shadow-2xl max-w-lg w-full">
      <h2 className="text-2xl font-black text-red-500 mb-4 flex items-center gap-2">
        <X className="bg-red-500 rounded-full p-1 text-white" size={24} />
        Yapılandırma Hatası
      </h2>
      <p className="text-zinc-400 mb-6">Uygulamanın çalışması için gerekli olan Firebase anahtarları bulunamadı. Lütfen GitHub Secrets ayarlarınızı kontrol edin.</p>
      <div className="bg-zinc-950 rounded-lg p-4 mb-6 font-mono text-sm border border-zinc-800">
        <p className="text-red-400 font-bold mb-2">Eksik/Hatalı Anahtarlar:</p>
        <ul className="list-disc list-inside text-zinc-500 space-y-1">
          {missingKeys.map(key => (
            <li key={key} className="text-zinc-300">VITE_FIREBASE_{key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}</li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-zinc-500 leading-relaxed italic">
        Not: GitHub Actions üzerinden deploy ediyorsanız; "Settings -> Secrets and Variables -> Actions" kısmında bu isimlerle secret eklediğinizden emin olun.
      </p>
    </div>
  </div>
);

// Sadece yapılandırma tamsa Firebase'i başlat
let app, auth, db, rtdb;
if (missingKeys.length === 0) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  rtdb = getDatabase(app);
}

const appId = 'anime-tier-list-app';

// Tier Listesi Kategorileri
const TIERS = [
  { id: 'S', name: 'S', color: 'bg-red-500', text: 'text-white' },
  { id: 'A', name: 'A', color: 'bg-orange-500', text: 'text-white' },
  { id: 'B', name: 'B', color: 'bg-yellow-400', text: 'text-black' },
  { id: 'C', name: 'C', color: 'bg-green-500', text: 'text-white' },
  { id: 'D', name: 'D', color: 'bg-blue-500', text: 'text-white' },
  { id: 'F', name: 'ÇÖP', color: 'bg-gray-700', text: 'text-white' }
];

// Rastgele İmleç Rengi
const getRandomColor = () => {
  const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#06b6d4'];
  return colors[Math.floor(Math.random() * colors.length)];
};

export default function App() {
  // 0. Yapılandırma Hatası Kontrolü
  if (missingKeys.length > 0) {
    return <ConfigurationError />;
  }

  // Kullanıcı Durumları
  const [user, setUser] = useState(null);
  const [username, setUsername] = useState('');
  const [isJoined, setIsJoined] = useState(false);

  // Veri Durumları
  const [animes, setAnimes] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [cursors, setCursors] = useState({});
  const [loading, setLoading] = useState(true);
  const [myColor] = useState(getRandomColor());

  // Arayüz ve Etkileşim Durumları
  const [activeAnime, setActiveAnime] = useState(null);
  const draggingIdRef = useRef(null);
  const [cooldown, setCooldown] = useState(0); // 2 saniyelik ceza sistemi -> aslında koda göre 60sn, vs
  const lockTimerRef = useRef(null); // EKLENDİ: 20 Saniyelik AFK/Trol sayacı

  // 1. İsim ve Giriş Kontrolü
  useEffect(() => {
    const savedName = localStorage.getItem('anime_tier_username');
    if (savedName) {
      setUsername(savedName);
      setIsJoined(true);
    }
  }, []);

  const handleJoin = (e) => {
    e.preventDefault();
    if (username.trim().length > 0) {
      const finalName = username.trim().substring(0, 15);
      localStorage.setItem('anime_tier_username', finalName);
      setUsername(finalName);
      setIsJoined(true);
    }
  };

  // 2. Firebase Yetkilendirme
  useEffect(() => {
    const initAuth = async () => {
      try {
        await signInAnonymously(auth);
      } catch (error) {
        console.error("Auth error:", error);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // 2.5 Realtime Database Presence (Çıkış yapınca imleci sil)
  useEffect(() => {
    if (user) {
      const myCursorRef = ref(rtdb, `cursors/${appId}/${user.uid}`);
      onDisconnect(myCursorRef).remove();
    }
  }, [user]);

  // 3. AniList API'den Animeleri Çekme
  useEffect(() => {
    if (!isJoined) return;
    const fetchAnimes = async () => {
      const query = `
        query {
          Page(page: 1, perPage: 100) {
            media(season: WINTER, seasonYear: 2026, type: ANIME, isAdult: false, sort: POPULARITY_DESC) {
              id
              title { romaji }
              coverImage { large }
            }
          }
        }
      `;
      try {
        const response = await fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ query })
        });
        const data = await response.json();
        if (data?.data?.Page?.media) setAnimes(data.data.Page.media);
      } catch (error) {
        console.error("AniList fetch error:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchAnimes();
  }, [isJoined]);

  // 4. Veritabanı Senkronizasyonu (Tier: Firestore, İmleçler: RTDB)
  useEffect(() => {
    if (!user || !isJoined) return;

    // Firestore - Tier Listesi
    const assignmentsRef = collection(db, 'artifacts', appId, 'public', 'data', 'tier_assignments');
    const unsubscribeAssignments = onSnapshot(assignmentsRef, (snapshot) => {
      const newAssignments = {};
      snapshot.forEach(doc => { newAssignments[doc.id] = doc.data(); });
      setAssignments(newAssignments);
    });

    // RTDB - İmleçler
    const cursorsDbRef = ref(rtdb, `cursors/${appId}`);
    const unsubscribeCursors = onValue(cursorsDbRef, (snapshot) => {
      const newCursors = {};
      const now = Date.now();
      const val = snapshot.val();
      if (val) {
        Object.keys(val).forEach(key => {
          if (key !== user.uid) {
            const data = val[key];
            if (now - data.timestamp < 10000) newCursors[key] = data; // 10 sn boşta kalanı gizle
          }
        });
      }
      setCursors(newCursors);
    });

    return () => {
      unsubscribeAssignments();
      unsubscribeCursors();
    };
  }, [user, isJoined]);

  // 5. İmleç Gönderimi
  useEffect(() => {
    if (!user || !isJoined) return;

    let lastUpdate = 0;
    const handleUpdateLocation = (x, y) => {
      const now = Date.now();
      if (now - lastUpdate > 75 && x > 0) {
        const cursorRef = ref(rtdb, `cursors/${appId}/${user.uid}`);
        update(cursorRef, {
          x: x / document.documentElement.scrollWidth,
          y: y / document.documentElement.scrollHeight,
          color: myColor,
          name: username,
          timestamp: now
        }).catch(() => { });
        lastUpdate = now;
      }
    };

    const handleMouseMove = (e) => handleUpdateLocation(e.pageX, e.pageY);
    const handleTouch = (e) => {
      if (e.touches && e.touches[0]) {
        handleUpdateLocation(e.touches[0].pageX, e.touches[0].pageY);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('dragover', handleMouseMove);
    window.addEventListener('touchstart', handleTouch);
    window.addEventListener('touchmove', handleTouch);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('dragover', handleMouseMove);
      window.removeEventListener('touchstart', handleTouch);
      window.removeEventListener('touchmove', handleTouch);
    };
  }, [user, isJoined, myColor, username]);

  // 6. Cooldown (Bekleme Süresi) Sayacı
  useEffect(() => {
    if (cooldown > 0) {
      const timer = setTimeout(() => setCooldown(c => c - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [cooldown]);

  // -- KİLİT SÜRESİ (AFK/TROL KORUMASI) --
  const clearLockTimer = () => {
    if (lockTimerRef.current) {
      clearTimeout(lockTimerRef.current);
      lockTimerRef.current = null;
    }
  };

  const startLockTimer = () => {
    clearLockTimer();
    lockTimerRef.current = setTimeout(() => {
      // 20 saniye doldu ve hala yerleştirmedi!
      setActiveAnime(null); // Modalı kapat
      draggingIdRef.current = null; // Sürüklemeyi iptal et
      updateInteractionToDB(null, null); // Veritabanındaki kilidi aç
      setCooldown(8); // 8 SANİYE CEZA VER
    }, 20000); // 20 saniye
  };

  // -- VERİTABANI ETKİLEŞİM DURUMU GÜNCELLEYİCİ --
  const updateInteractionToDB = (animeId, type) => {
    if (!user) return;
    const cursorRef = ref(rtdb, `cursors/${appId}/${user.uid}`);
    update(cursorRef, {
      interactingAnimeId: animeId,
      interactionType: type, // 'click', 'drag' veya null
      timestamp: Date.now()
    }).catch(() => { });
  };

  // Bir animenin kilitli olup olmadığını sorgulama
  const getLockInfo = (animeId) => {
    for (const [uid, cursor] of Object.entries(cursors)) {
      if (cursor.interactingAnimeId === animeId) {
        return { isLocked: true, color: cursor.color, name: cursor.name, isMe: false };
      }
    }
    if (activeAnime?.id === animeId || draggingIdRef.current === animeId) {
      return { isLocked: true, color: myColor, name: username, isMe: true };
    }
    return null;
  };

  // TIKLAMA ve MODAL MANTIĞI
  const handleAnimeClick = (anime) => {
    if (cooldown > 0) return; // Cooldown varsa engelle
    const lock = getLockInfo(anime.id);
    if (lock && !lock.isMe) return; // Başkası kilitlediyse engelle

    setActiveAnime(anime);
    updateInteractionToDB(anime.id, 'click');
    startLockTimer(); // 20 saniyelik süreyi başlat
  };

  const closeModal = () => {
    setActiveAnime(null);
    updateInteractionToDB(null, null);
    clearLockTimer(); // İptal ederse süreyi durdur
  };

  // SÜRÜKLE BIRAK MANTIĞI
  const handleDragStart = (e, animeId) => {
    if (cooldown > 0) { e.preventDefault(); return; }
    const lock = getLockInfo(animeId);
    if (lock && !lock.isMe) { e.preventDefault(); return; }

    e.dataTransfer.setData('animeId', animeId);
    e.dataTransfer.effectAllowed = 'move';
    draggingIdRef.current = animeId;
    updateInteractionToDB(animeId, 'drag');
    startLockTimer(); // 20 saniyelik süreyi başlat
  };

  const handleDragEnd = () => {
    draggingIdRef.current = null;
    if (!activeAnime) {
      updateInteractionToDB(null, null);
      clearLockTimer(); // İptal ederse süreyi durdur
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (e, tierId) => {
    e.preventDefault();
    if (cooldown > 0) return;
    const animeId = e.dataTransfer.getData('animeId');
    if (animeId && user) {
      await updateAnimeTier(animeId, tierId);
    }
  };

  // Tier Güncelleme (Ve İşlem Sonrası Cooldown)
  const updateAnimeTier = async (animeId, tierId) => {
    if (!user || cooldown > 0) return;
    try {
      const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'tier_assignments', animeId.toString());
      await setDoc(docRef, { tier: tierId, updatedBy: user.uid, updatedAt: serverTimestamp() });

      clearLockTimer(); // Başarıyla yerleştirdi, trol sayacını durdur
      setActiveAnime(null);
      draggingIdRef.current = null;
      updateInteractionToDB(null, null);
      setCooldown(60); // 1 DAKİKA (60 SANİYE) BEKLEME CEZASI VER
    } catch (error) {
      console.error("Update tier error:", error);
    }
  };

  const getAnimesInTier = (tierId) => {
    return animes.filter(anime => {
      const currentTier = assignments[anime.id]?.tier || 'pool';
      return currentTier === tierId;
    });
  };

  // EKRANLAR
  if (!isJoined) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-white font-sans px-4">
        <form onSubmit={handleJoin} className="bg-zinc-900 p-8 rounded-2xl border border-zinc-800 shadow-2xl w-full max-w-md flex flex-col gap-6 text-center">
          <div>
            <h1 className="text-3xl font-black bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500 mb-2">
              Kış 2026 Tier Listesi
            </h1>
            <p className="text-zinc-400 text-sm">Ortak çalışma alanına katılmak için bir isim gir.</p>
          </div>
          <input
            type="text"
            placeholder="Kullanıcı Adın"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={15}
            className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors text-center font-medium"
            autoFocus
          />
          <button type="submit" disabled={!username.trim()} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold py-3 rounded-lg transition-colors">
            Tier Listesine Katıl
          </button>
        </form>
      </div>
    );
  }

  if (loading || !user) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-white font-sans">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
        <span className="ml-4 text-lg">Animeler Çekiliyor...</span>
      </div>
    );
  }

  const poolAnimes = getAnimesInTier('pool');

  return (
    <div className="min-h-screen bg-zinc-950 text-white font-sans overflow-x-hidden relative">

      {/* 2 SANİYE COOLDOWN UYARISI */}
      {cooldown > 0 && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[200] bg-red-600 border-2 border-red-400 text-white px-6 py-2 rounded-full font-bold shadow-[0_0_20px_rgba(220,38,38,0.6)] animate-bounce pointer-events-none flex items-center gap-2">
          <Timer size={20} className="animate-pulse" />
          Lütfen bekle... {cooldown}s
        </div>
      )}

      {/* TIKLA VE TAŞI MODALI */}
      {activeAnime && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm"
          onClick={closeModal}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-2xl p-5 sm:p-6 w-full max-w-[320px] shadow-2xl flex flex-col items-center relative animate-in fade-in zoom-in-95 duration-200"
            onClick={e => e.stopPropagation()}
          >
            <button onClick={closeModal} className="absolute top-3 right-3 p-1 bg-zinc-800 rounded-full text-zinc-400 hover:text-white">
              <X size={20} />
            </button>
            <img src={activeAnime.coverImage.large} alt={activeAnime.title.romaji} className="w-28 h-40 object-cover rounded-lg shadow-lg mb-4 pointer-events-none" />
            <h3 className="text-base sm:text-lg font-bold text-center mb-5 line-clamp-2 leading-tight">{activeAnime.title.romaji}</h3>

            <div className="w-full grid grid-cols-2 gap-2 mb-3">
              {TIERS.map(tier => (
                <button
                  key={tier.id}
                  onClick={() => updateAnimeTier(activeAnime.id, tier.id)}
                  className={`${tier.color} ${tier.text} py-2.5 rounded-lg font-black text-sm sm:text-base transition-transform active:scale-95 hover:brightness-110 shadow-sm`}
                >
                  {tier.name}
                </button>
              ))}
            </div>
            <button
              onClick={() => updateAnimeTier(activeAnime.id, 'pool')}
              className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 py-2.5 rounded-lg font-medium text-sm transition-colors mt-1"
            >
              Havuza Geri Gönder
            </button>
          </div>
        </div>
      )}

      {/* DİĞER KULLANICILARIN İMLEÇLERİ */}
      {Object.entries(cursors).map(([uid, cursor]) => {
        const draggedAnime = (cursor.interactingAnimeId && cursor.interactionType === 'drag')
          ? animes.find(a => a.id === cursor.interactingAnimeId)
          : null;

        return (
          <div
            key={uid}
            className="absolute z-50 pointer-events-none transition-all duration-300 ease-out flex flex-col items-center"
            style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%`, transform: 'translate(-12px, -12px)' }}
          >
            {draggedAnime && (
              <div
                className="absolute top-6 left-6 shadow-2xl rounded-md overflow-hidden border-[3px] z-10 w-16 h-24 bg-zinc-800"
                style={{ borderColor: cursor.color, boxShadow: `0 0 20px ${cursor.color}90` }}
              >
                <img src={draggedAnime.coverImage.large} alt="dragging" className="w-full h-full object-cover" />
              </div>
            )}
            <MousePointer2 fill={cursor.color} color={cursor.color} size={24} className="-rotate-12 drop-shadow-lg relative z-20" />
            <div
              className="mt-1 px-2 py-0.5 rounded text-[11px] font-bold text-white whitespace-nowrap shadow-md relative z-20"
              style={{ backgroundColor: cursor.color }}
            >
              {cursor.name || 'Anon'}
            </div>
          </div>
        );
      })}

      {/* ÜST BİLGİ ÇUBUĞU */}
      <header className="p-4 sm:p-6 border-b border-zinc-800 bg-zinc-900 shadow-sm flex flex-col sm:flex-row justify-between items-center sticky top-0 z-40 gap-3">
        <div className="text-center sm:text-left">
          <h1 className="text-xl sm:text-2xl font-black bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500">
            2026 KIŞ TIER LIST
          </h1>
        </div>
        <div className="flex items-center gap-3 bg-zinc-950 px-4 py-2 rounded-full border border-zinc-800 shadow-inner">
          <Users size={16} className="text-zinc-400" />
          <span className="text-xs sm:text-sm font-medium text-zinc-300">
            Çevrimiçi: {Object.keys(cursors).length + 1}
          </span>
          <div className="w-2 h-2 rounded-full ml-1 animate-pulse" style={{ backgroundColor: myColor }}></div>
          <span className="text-xs font-bold ml-1" style={{ color: myColor }}>{username}</span>
        </div>
      </header>

      <main className="p-3 sm:p-6 max-w-[1600px] mx-auto flex flex-col gap-6 sm:gap-8 pb-20">

        {/* TIER TABLOSU */}
        <div className="flex flex-col gap-2 bg-zinc-900 p-2 sm:p-4 rounded-xl border border-zinc-800 shadow-xl">
          {TIERS.map(tier => (
            <div
              key={tier.id}
              className="flex min-h-[90px] sm:min-h-[120px] bg-zinc-950/50 rounded-lg overflow-hidden border border-zinc-800/50"
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, tier.id)}
            >
              <div className={`${tier.color} ${tier.text} w-16 sm:w-28 flex-shrink-0 flex items-center justify-center font-black text-2xl sm:text-4xl shadow-inner border-r border-black/20`}>
                {tier.name}
              </div>
              <div className="flex-1 p-2 flex flex-wrap gap-2 items-start content-start">
                {getAnimesInTier(tier.id).map(anime => (
                  <AnimeCard
                    key={anime.id}
                    anime={anime}
                    lockInfo={getLockInfo(anime.id)}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onClick={() => handleAnimeClick(anime)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* HAVUZ */}
        <div
          className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 shadow-xl min-h-[300px]"
          onDragOver={handleDragOver}
          onDrop={(e) => handleDrop(e, 'pool')}
        >
          <div className="flex items-center gap-3 mb-4 pb-3 border-b border-zinc-800">
            <h2 className="text-lg sm:text-xl font-bold text-zinc-200">Anime Havuzu</h2>
            <span className="text-xs sm:text-sm px-2.5 py-1 bg-zinc-800 rounded-md text-zinc-400 font-mono font-semibold shadow-inner">
              Kalan: {poolAnimes.length}
            </span>
          </div>

          <div className="flex flex-wrap gap-2 sm:gap-3 justify-center sm:justify-start">
            {poolAnimes.map(anime => (
              <AnimeCard
                key={anime.id}
                anime={anime}
                lockInfo={getLockInfo(anime.id)}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onClick={() => handleAnimeClick(anime)}
              />
            ))}
          </div>
        </div>

      </main>
    </div>
  );
}

// Alt Bileşen: Anime Kartı
function AnimeCard({ anime, onDragStart, onDragEnd, onClick, lockInfo }) {
  const isLockedByOther = lockInfo?.isLocked && !lockInfo?.isMe;

  return (
    <div
      draggable={!isLockedByOther}
      onDragStart={(e) => {
        if (isLockedByOther) { e.preventDefault(); return; }
        onDragStart(e, anime.id);
      }}
      onDragEnd={onDragEnd}
      onClick={() => {
        if (isLockedByOther) return;
        onClick();
      }}
      style={{
        borderColor: lockInfo ? lockInfo.color : 'transparent',
      }}
      className={`
        relative w-[60px] h-[85px] sm:w-[80px] sm:h-[115px] md:w-[90px] md:h-[130px]
        rounded bg-zinc-800 overflow-hidden group flex-shrink-0
        border-[3px] transition-all
        ${isLockedByOther ? 'cursor-not-allowed opacity-70 grayscale-[50%]' : 'cursor-pointer sm:cursor-grab active:cursor-grabbing hover:-translate-y-1 hover:shadow-xl hover:ring-2 hover:ring-blue-500'}
      `}
    >
      {/* KİLİT YAPANIN İSMİ (Veya "SENDE" Uyarısı) */}
      {lockInfo && (
        <div
          className="absolute top-0 inset-x-0 py-0.5 text-[8px] sm:text-[9px] font-black text-white text-center z-10 truncate px-1 shadow-md"
          style={{ backgroundColor: lockInfo.color }}
        >
          {lockInfo.isMe ? 'SENDE' : lockInfo.name}
        </div>
      )}

      <img
        src={anime.coverImage.large}
        alt={anime.title.romaji}
        className="w-full h-full object-cover select-none pointer-events-none"
        draggable="false"
      />

      {/* İsim Tooltip'i */}
      {!lockInfo && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/80 to-transparent p-1 pt-4 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          <p className="text-[9px] sm:text-[10px] md:text-xs font-semibold text-white text-center leading-tight line-clamp-2">
            {anime.title.romaji}
          </p>
        </div>
      )}
    </div>
  );
}
