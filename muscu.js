'use strict';
// Fiches des routines de renfo (doc « Routine musculation coureur »).
// Images : free-exercise-db (Unlicense, domaine public), figée sur un commit.
// shortcut: images chargées depuis GitHub ; les copier dans le dépôt si GitHub devient lent ou indisponible.
const IMG = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5/exercises/';

const ROUTINES = [
  {
    id: 'A', nom: 'Séance A : force', duree: '35 min',
    intro: "Charges lourdes, peu de répétitions, 2 min de récup entre les séries. Arrêter chaque série à 2–3 répétitions de l'échec (RIR 2–3).",
    echauffement: '5 min de vélo ou rameur (maison : montées de genoux sur place), puis 10 monster walks élastique aux genoux et 10 ponts fessiers.',
    exercices: [
      {
        id: 'squat', nom: 'Squat à 90°', series: '3 × 5–6 (salle) / 3 × 12 (maison)', img: 'Barbell_Squat', imgMaison: 'Squats_-_With_Bands',
        salle: 'Squat goblet (haltère contre la poitrine), puis squat barre sur le haut du dos.',
        maison: 'Élastique sous les pieds, poignées aux épaules. Descente en 3 s.',
        comment: ["Pieds largeur d'épaules, pointes légèrement ouvertes.", 'Inspirer, gainer le ventre, descendre en poussant les fesses en arrière.', "S'arrêter cuisses parallèles au sol (genou à 90°).", 'Remonter en poussant le sol, en soufflant.'],
        consignes: ['Genoux dans l\'axe des pieds.', 'Talons au sol, poitrine fière.', 'Pas plus bas que 90° pour le genou droit au début.'],
        erreurs: ['Genoux qui rentrent vers l\'intérieur.', 'Dos qui s\'arrondit en bas.', 'Talons qui décollent.'],
      },
      {
        id: 'rdl', nom: 'Soulevé de terre roumain', series: '3 × 6–8', img: 'Romanian_Deadlift', imgMaison: 'Kettlebell_One-Legged_Deadlift',
        salle: 'Barre ou haltères.',
        maison: "Sur une jambe, élastique sous le pied d'appui (ou sac à dos dans la main opposée).",
        comment: ['Debout, charge devant les cuisses, genoux légèrement fléchis.', 'Pousser les fesses en arrière, la charge glisse le long des jambes.', "Descendre jusqu'à sentir l'étirement derrière les cuisses (mi-tibia environ).", 'Remonter en serrant les fesses.'],
        consignes: ['Dos plat du début à la fin.', 'Charge collée aux jambes.', 'Les genoux ne bougent presque pas : c\'est la hanche qui travaille.'],
        erreurs: ['Arrondir le dos pour aller plus bas.', 'Transformer le mouvement en squat.', 'Se cambrer en haut.'],
      },
      {
        id: 'bulgare', nom: 'Fente bulgare', series: '3 × 6 par jambe', img: 'One_Leg_Barbell_Squat',
        salle: 'Haltères, pied arrière posé sur un banc.',
        maison: 'Poids du corps ou sac à dos chargé, pied arrière sur une chaise ou le canapé.',
        comment: ['Dos au banc, poser le dessus du pied arrière dessus.', 'Pied avant assez loin pour que le genou reste au-dessus de la cheville.', 'Descendre droit vers le bas, genou arrière vers le sol.', 'Remonter en poussant sur le talon avant.'],
        consignes: ['Le poids est sur la jambe avant.', 'Genou avant dans l\'axe du pied.', 'Buste légèrement penché en avant, c\'est normal.'],
        erreurs: ['Pied avant trop près du banc.', 'Pousser avec la jambe arrière.', 'Genou avant qui part vers l\'intérieur.'],
      },
      {
        id: 'mollets', nom: 'Mollets jambe tendue', series: '3 × 8–10', img: 'Standing_Calf_Raises',
        salle: 'Machine à mollets ou Smith, 1 s en haut.',
        maison: 'Sur une jambe, avant du pied sur une marche, 3 s en descente.',
        comment: ['Avant du pied sur le bord, talon dans le vide.', 'Monter le plus haut possible sur la pointe, tenir 1 s.', 'Redescendre lentement sous le niveau de la marche.'],
        consignes: ['Jambe tendue (sans verrouiller le genou).', 'Amplitude complète, en haut comme en bas.'],
        erreurs: ['Rebondir en bas.', 'Faire des demi-mouvements trop rapides.'],
      },
      {
        id: 'soleaire', nom: 'Mollets genou fléchi (soléaire)', series: '3 × 12', img: 'Seated_Calf_Raise',
        salle: 'Machine à mollets assise.',
        maison: 'Sur une jambe, genou fléchi (~30°), avant du pied sur une marche.',
        comment: ['Genou fléchi pendant tout le mouvement.', 'Monter sur la pointe, tenir 1 s.', 'Redescendre lentement.'],
        consignes: ['Le genou reste plié : c\'est ce qui fait travailler le soléaire, le muscle qui encaisse le plus en course.'],
        erreurs: ['Tendre la jambe en montant.', 'Aller trop vite.'],
      },
      {
        id: 'pallof', nom: 'Pallof press (gainage anti-rotation)', series: '3 × 10 par côté', img: 'Pallof_Press',
        salle: 'Poulie à hauteur de poitrine.',
        maison: 'Élastique accroché à une poignée de porte ou un pied de table, à hauteur de poitrine.',
        comment: ['De profil par rapport à la poulie, poignée contre la poitrine.', 'Pieds largeur de hanches, genoux souples, ventre gainé.', 'Tendre les bras devant soi, tenir 2 s.', 'Ramener la poignée à la poitrine.'],
        consignes: ['Le buste ne tourne pas : c\'est tout l\'exercice.', 'Souffler en tendant les bras.'],
        erreurs: ['Se laisser tourner vers la poulie.', 'Se cambrer.', 'Charge trop lourde.'],
      },
    ],
  },
  {
    id: 'B', nom: 'Séance B : genou, hanches', duree: '30 min',
    intro: 'Charges modérées, contrôle et équilibre sur une jambe, un peu de rebonds. Elle se fait aussi bien à la maison qu\'en salle.',
    echauffement: 'Même échauffement que la séance A.',
    exercices: [
      {
        id: 'stepup', nom: 'Step-up', series: '3 × 8 par jambe', img: 'Dumbbell_Step_Ups',
        salle: 'Haltères, box haute (genou à ~90° pied posé), montée lente.',
        maison: 'Poids du corps sur une chaise solide calée contre un mur.',
        comment: ['Poser tout le pied sur la box.', 'Monter en poussant sur le talon de la jambe du haut.', 'Redescendre lentement, sur 2–3 s.'],
        consignes: ['La jambe du bas ne pousse pas.', 'Genou dans l\'axe du pied.'],
        erreurs: ['Prendre un élan avec la jambe du bas.', 'Retomber lourdement.', 'Box trop haute au début.'],
      },
      {
        id: 'tke', nom: 'Extension terminale du genou (TKE)', series: '3 × 15 par jambe', img: null,
        salle: 'Élastique ou poulie basse passé derrière le genou.',
        maison: 'Élastique accroché à un pied de table, à hauteur de genou.',
        comment: ['Passer l\'élastique derrière le genou, face au point d\'attache, en reculant pour le mettre en tension.', 'Partir genou légèrement fléchi (~30°), talon au sol.', "Tendre complètement le genou en contractant la cuisse, tenir 2 s.", 'Relâcher lentement.'],
        consignes: ['Penser « serrer le haut du genou ».', 'Jambe droite en priorité (genou opéré).'],
        erreurs: ['Bouger la hanche au lieu du genou.', 'Élastique trop faible : la tension doit se sentir à la fin.'],
      },
      {
        id: 'hipthrust', nom: 'Hip thrust', series: '3 × 10', img: 'Barbell_Hip_Thrust', imgMaison: 'Single_Leg_Glute_Bridge',
        salle: 'Barre sur les hanches (avec une mousse), haut du dos sur un banc.',
        maison: 'Sur une jambe, élastique tendu sur les hanches et coincé sous les pieds ou les mains.',
        comment: ['Haut du dos sur le banc, pieds à plat, genoux pliés.', 'Monter les hanches jusqu\'à l\'alignement épaules-hanches-genoux.', 'Serrer les fesses 1 s en haut.', 'Redescendre lentement.'],
        consignes: ['Menton rentré, regard vers les genoux.', 'Tibias verticaux en haut.'],
        erreurs: ['Se cambrer en haut au lieu de serrer les fesses.', 'Pousser sur les pointes de pieds.'],
      },
      {
        id: 'copenhagen', nom: 'Copenhagen plank (adducteurs)', series: '2 × 20 s par côté', img: 'Side_Bridge',
        legende: 'Photo : planche latérale, la base. Pour la Copenhague, le genou (ou le pied) du dessus est posé sur le banc et la jambe du dessous est dans le vide.',
        salle: 'Genou du dessus posé sur un banc.',
        maison: 'Genou du dessus posé sur le canapé.',
        comment: ['En planche latérale sur l\'avant-bras, poser l\'intérieur du genou du dessus sur le banc.', 'Décoller les hanches : le corps est droit.', 'La jambe du dessous reste dans le vide (ou au sol pour débuter).', 'Tenir.'],
        consignes: ['Version genou sur le banc d\'abord, pied sur le banc plus tard.', 'Arrêter si douleur à l\'aine.'],
        erreurs: ['Hanches qui tombent.', 'Corps qui bascule en avant.'],
      },
      {
        id: 'abduction', nom: 'Abduction de hanche', series: '2 × 12 par côté', img: 'Thigh_Abductor', imgMaison: 'Monster_Walk',
        salle: 'Machine à abducteurs ou poulie basse à la cheville.',
        maison: 'Planche latérale + clamshell avec élastique au-dessus des genoux (ou monster walk).',
        comment: ['Machine : dos calé, écarter les jambes lentement, revenir sans lâcher.', 'Clamshell : allongé sur le côté, genoux pliés, pieds joints, ouvrir le genou du dessus sans bouger le bassin.'],
        consignes: ['Mouvement lent, 1 s tenue à l\'ouverture.', 'C\'est le moyen fessier : il stabilise le bassin et le genou à chaque foulée.'],
        erreurs: ['Bassin qui roule en arrière (clamshell).', 'Aller vite avec trop de charge.'],
      },
      {
        id: 'pogo', nom: 'Pogo jumps (rebonds chevilles)', series: '3 × 15', img: 'Rope_Jumping',
        legende: 'Photo : corde à sauter. Les pogo, c\'est le même rebond, sans corde.',
        salle: 'Sur place.', maison: 'Sur place.',
        comment: ['Debout, pieds largeur de hanches.', 'Petits rebonds rapides sur l\'avant du pied, jambes presque tendues.', 'Le moins de temps possible au sol, comme une balle.'],
        consignes: ['Réceptions silencieuses.', 'Genoux dans l\'axe.', 'Arrêter dès que les rebonds deviennent lourds.'],
        erreurs: ['Plier les genoux à chaque saut.', 'Retomber sur les talons.'],
      },
      {
        id: 'deadbug', nom: 'Dead bug', series: '2 × 8 par côté', img: 'Dead_Bug',
        salle: 'Au sol.', maison: 'Au sol, élastique tendu entre les mains pour plus de difficulté.',
        comment: ['Sur le dos, bras tendus vers le plafond, hanches et genoux à 90°.', 'Plaquer le bas du dos au sol en soufflant.', 'Tendre un bras et la jambe opposée vers le sol, sans le toucher.', 'Revenir et changer de côté.'],
        consignes: ['Le bas du dos reste collé au sol tout le temps.', 'Lent et contrôlé.'],
        erreurs: ['Bas du dos qui se décolle.', 'Bloquer la respiration.'],
      },
    ],
  },
];

// « S2 - Renfo A (force) » -> 'A'
const routineOf = (name) => (/renfo\s+([AB])\b/i.exec(name || '') || [])[1]?.toUpperCase() || null;

// À la maison, la charge est un niveau d'élastique (index dans BANDES).
const BANDES = ['Poids du corps', 'Élastique léger', 'Élastique moyen', 'Élastique fort', 'Élastique très fort'];

// « 3 × 5–6 (salle) / 3 × 12 (maison) », « 2 × 20 s par côté » -> { sets, min, max, sec }
function parseSeries(series, lieu = 'salle') {
  const parts = String(series).split('/');
  const part = parts.find((x) => x.includes(`(${lieu})`)) || parts[0];
  const m = /(\d+)\s*×\s*(\d+)(?:\s*[–-]\s*(\d+))?\s*(s\b)?/.exec(part);
  if (!m) return { sets: 3, min: 8, max: 12, sec: false };
  return { sets: +m[1], min: +m[2], max: +(m[3] || m[2]), sec: !!m[4] };
}

// Double progression : toutes les séries au haut de la fourchette -> on monte la charge ; sinon même charge, une rep de plus.
// last = { bande?, series: [{ reps, kg? }] } (dernière fois au même endroit). Renvoie { kg, bande, reps, text }.
function suggest(t, last, lieu) {
  const unit = t.sec ? ' s' : ' reps';
  if (!last?.series?.length) {
    return { kg: null, bande: 0, reps: t.max, text: t.sec ? 'Première fois : tiens le temps prévu sans perdre la position.' : 'Première fois : prends une charge qui te laisse 2–3 reps en réserve.' };
  }
  const kg = Math.max(0, ...last.series.map((x) => x.kg || 0)) || null;
  const bande = last.bande || 0;
  const top = last.series.length >= t.sets && last.series.every((x) => x.reps >= t.max);
  const miss = last.series.some((x) => x.reps < t.min);
  const best = Math.max(...last.series.map((x) => x.reps));
  const charge = lieu === 'maison' ? BANDES[bande].toLowerCase() : kg ? `${String(kg).replace('.', ',')} kg` : 'poids du corps';
  if (top) {
    if (t.sec) return { kg, bande, reps: t.max + 5, text: `Tenu ${t.max} s partout : passe à ${t.max + 5} s.` };
    if (lieu === 'maison' && bande < BANDES.length - 1) return { kg, bande: bande + 1, reps: t.min, text: `Toutes les séries à ${t.max} reps : passe à ${BANDES[bande + 1].toLowerCase()}, vise ${t.min} reps.` };
    if (lieu === 'salle' && kg) {
      const next = Math.round((kg + (kg >= 20 ? 2.5 : 1)) * 10) / 10;
      return { kg: next, bande, reps: t.min, text: `Toutes les séries à ${t.max} reps : passe à ${String(next).replace('.', ',')} kg, vise ${t.min} reps.` };
    }
    return { kg, bande, reps: t.max + 2, text: `Toutes les séries à ${t.max} reps : ajoute 2 reps ou descends plus lentement (4 s).` };
  }
  if (miss) return { kg, bande, reps: t.min, text: `Pas toutes les ${t.min}${unit} la dernière fois : garde ${charge} et vise ${t.min}${unit}.` };
  const reps = Math.min(t.max, best + (t.sec ? 5 : 1));
  return { kg, bande, reps, text: `Garde ${charge}, vise ${reps}${unit} par série.` };
}

// Séances triées de la plus récente à la plus ancienne -> dernier passage de l'exercice au même endroit.
const lastFor = (sessions, exId, lieu) => sessions.find((x) => x.lieu === lieu && x.exercices?.[exId]?.series?.length)?.exercices[exId] || null;

module.exports = { IMG, ROUTINES, BANDES, routineOf, parseSeries, suggest, lastFor };
