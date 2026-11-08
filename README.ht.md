# Carnet santé Helper (estansyon Chrome / Edge)

[English](README.md) · [Français](README.fr.md) · [中文](README.zh.md) · [العربية](README.ar.md) · [Español](README.es.md) · **Kreyòl ayisyen**

Telechaje an lo epi òganize otomatikman rapò ou yo sou [Carnet santé Québec](https://carnetsante.gouv.qc.ca) — pòtal sante Quebec la:

- **Prélèvements** (rezilta laboratwa)
- **Imagerie médicale** (imaj medikal)
- **Médications** (òdonnans doktè) — ekspòte kòm yon enstantane CSV/JSON nan lòd kwonolojik (medikaman an, DIN, klas li, doktè a, famasi a, renouvèlman ki rete…) pou wè sitiyasyon medikaman ou peryòd pa peryòd

Pòtal la pa gen fonksyon ekspòte an lo; estansyon sa a fè l pou ou, nan sesyon ou menm ki konekte. Entèfas la pale 13 lang, epi li swiv mòd klè/nwa sistèm ou an.

## Sa ou ap jwenn

Chak PDF klase pa dat ak pa non, plis yon endèks rezime — nan dosiye telechajman navigatè ou an (pa défòt) oswa nan yon dosiye ou chwazi:

```
Downloads/
└── Carnet santé/
    ├── Prélèvements/
    │   └── 2026-02-01 - Hémogramme.pdf
    ├── Imagerie médicale/
    │   └── 2026-05-15 - Radiographie thorax.pdf
    ├── Médications/
    │   ├── ordonnances-20261107-1530.csv    ← yon liy pa òdonnans, klase pa dat
    │   └── ordonnances-20261107-1530.json   ← menm done yo + konte pa ane
    ├── index-20261107-1530.csv      ← tablo rezime tout rapò yo
    └── donnees-20261107-1530.json   ← menm done yo, fòma machin
```

Rapò ki deja telechaje yo **inyore otomatikman**: ou ka reji li peryodikman, se sèlman rapò nouvo ki ap telechaje. Enstantane òdonnans yo rejenere chak fwa w ap lance l (kèk demann sèlman; renouvèlman ki rete yo chanje ak tan).

## Enstale — yon fwa pa òdinatè

**Opsyon A · ak script enstalasyon an (maj fasil)**

Sou yon nouvo machin (depo a prive — ou bezwen Git ak koneksyon GitHub ou):

macOS / Linux — Tèminal:
```sh
gh repo clone bellchu/CarnetSanteHelper ~/Code/CarnetSanteHelper
bash ~/Code/CarnetSanteHelper/tools/install.sh
```

Windows — PowerShell:
```powershell
gh repo clone bellchu/CarnetSanteHelper $HOME\Code\CarnetSanteHelper
cd $HOME\Code\CarnetSanteHelper
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

Ou deja klone l? Andedan depo a, kouri `bash tools/install.sh` (macOS/Linux) oswa `powershell -ExecutionPolicy Bypass -File tools\install.ps1` (Windows). Script la mete kòd ajou, kopye chemen estansyon an nan clipboard ou, epi li ouvri paj estansyon navigatè a.

**Opsyon B · san Git — telechaje yon ZIP**

1. Sou GitHub: bouton vèt **Code** → **Download ZIP** → dekonprese l (egzanp `CarnetSanteHelper-main`).
2. Kopye chemen konplè **dosiye dekonprese a** (pa fichye ZIP la). Sou Windows: Shift + klike dwat sou dosiye a → **Kopye kòm chemen**.

**Apre sa, nan Chrome oswa Edge (sèl etap manuel la — se yon règ sekirite navigatè a pou estansyon ki pa pibliye):**

1. Ouvri `chrome://extensions` (Edge: `edge://extensions`).
2. Ouvri **mòd devlopè** a (anwo adwat).
3. Klike **Chaje estansyon dekonprese** → kole chemen an (⌘⇧V / Ctrl+Shift+V) → Entrée.

✅ **L' fini lè:** yon kat "Carnet santé Helper" parèt sou paj la. Konsèy: pinel — ikon pyès wig nan barèl la → pine — pou l toujou la an yon klike.

**Mete ajou pita:** reji script la (oswa retelechaje ZIP la), epi klike **Rechaje ↻** sou kat estansyon an. Dènye klike sa a pa ka otomatik — se règ navigatè a, se pa yon erè.

## Premye itilizasyon — 4 etap

1. **Konekte** nan [carnetsante.gouv.qc.ca](https://carnetsante.gouv.qc.ca) epi rete sou nenpòt paj pòtal la.
2. **Klike ikon estansyon an.** Nan youn oswa de segond, ti fenèt la dwe montre *Konekte: non ou*. Si l di pa gen sesyon: aktyalize onglet pòtal la, epi reouvri ti fenèt la.
3. **Premye fwa? Kouche «Sèlman eskane»** epi peze *Eskane* — l konte rapò yo ki ta telechaje, san telechaje anyen. Chif yo bon pou ou? Dekouche l, epi peze *Telechaje*.
4. **Swiv pwogrè a** nan ti fenèt la (ba pwogrè, konte pa seksyon, jounal an dirèk). Lè l fini, ouvri fichye ou yo ak bouton 📁 an tèt fenèt la. **Pa fèmen onglet pòtal la pandan l ap mache.**

## Paramèt (⚙)

| Paramèt | Sa l fè |
|---|---|
| Dosiye rapò yo | **Chwazi nenpòt ki dosiye sou disk ou** (Chrome/Edge òdinatè): rapò yo ekri dirèkteman ladan l, ak sou-dosiye. Chwazi «Pèmèt chak vizit» lè w ap otorize, pou ou pa dwe reotorize. Si l pa disponib, l retounen nan dosiye telechajman an |
| Dosiye rasin / sou-dosiye | Estrikti achiv la, pa défòt `Carnet santé/Prélèvements`, `Imagerie médicale` ak `Médications` (aperçu an dirèk; chemen absoli yo konvèti an chemen relatif — navigatè a pa pèmèt ekri deyò dosiye telechajman an) |
| Modèl non fichye | Variable `{date} {label} {prescriber} {section} {id} {year}`, pa défòt `{date} - {label}` |
| Intèval ant rapò | 400 ms pa défòt — kite l anlè 0, se rèspe pou sit la |
| Peryòd | Detekte otomatikman: lè w ouvri l, estansyon an chwazi done ki pi ansyen ou epi li sèlman ofri peryòd ki egziste reyèlman (evite erè sou plaj vid); plaj fiks si deteksyon an echwe |
| Inyore telechaje | Swit dedoubman; *Efase istwa* fòse yon telechajman konplè |

## Kòman l mache ak vi prive

Pòtal la se yon aplikasyon Angular san API piblik. Estansyon an reitilize sesyon ou: li li jeton OIDC pòtal la nan paj la, li rele menm endpoint prive `/api/1` ke sit la sèvi (imaj: lis → metadone → PDF; laboratwa: lis anyèl → PDF an base64 andedan JSON la; medikaman: lis pa moso ≤2 ane, san PDF — ekri kòm enstantane CSV/JSON), epi li sove atravè `chrome.downloads` oswa API File System Access.

Tout bagay pase lokalman nan navigatè ou a. **Estansyon an pa konekte ak okenn sèvis twazyèm pati, li pa kolekte ni voye anyen**; jeton an sèlman sèvi pou jwenn dosye ou menm.

## Dépanaj

| Sentòm | Solisyon |
|---|---|
| «Pa gen sesyon ki detekte» | Konekte nan pòtal la, rete sou paj l, aktyalize yon fwa, reouvri ti fenèt la |
| «Failed to fetch» | Blokaj rezo/CORS: aktyalize onglet pòtal ki konekte a, eseye ankò |
| Yon bwat dyalog sovægade louvri pou chak fichye | Paramèt «Mande kote pou sove chak fichye» a louvri — fèmen l nan `chrome://settings/downloads`, reji |
| ⚠ sou dosiye a / sib ak ⚠ | Otorizasyon an expire (ka rive apre w rdemare navigatè a): rechwazi dosiye a nan ⚙ Paramèt |
| Fichye pa nan dosiye chwazi a | Dosiye deplase / debranche → retounen otomatikman nan telechajman — gade erè/jounal la nan ti fenèt la |
| Anpil echwe / 401 an mitan | Jeton pwobableman expire — estansyon an renouvèl li yon fwa; si l kontinye, aktyalize paj pòtal la epi reji (sa ki deja telechaje inyore) |
| «Analiz pa disponib» | Fonksyon an pa aktive pou kont ou — estansyon an inyore seksyon sa a epi li kontinye ak imaj |
| Kèk ane bay HTTP 500 | Sèvè a sansib sou plaj dat — estansyon an reeseye otomatikman (chanje fòma → ane pa ane); sa ki rete yo enskri nan erè epi inyore, souvan anreta retansyon an liy (~3 an) |
| Pa jwenn fichye yo | Bouton 📁 an tèt fenèt la; oswa gade telechajman navigatè a (yo anba `Carnet santé/`) |

## Limit ak devlopman

- Depan de endpoint prive `/api/1` pòtal la; yon refòm gouvènman ka mande yon maj (endpoint yo grupen an tèt `lib/pipeline.js`).
- Vaksinasyon se sou yon lòt pòtal; valè laboratwa anyèl (`ResultatsAnalyse`) pa enkli.
- Pou òganize **dosye sante ou menm** — itilize l avèk judgement (intèval pa défòt la gen rezon l).

Devlopè: `npm test` — 41 tès inite + entegrasyon ki simile tout pipeline a kont yon `/api/1` fèt ak men. Estrikti: `lib/` (lojik + òkestrasyon), `content/` (jeton + apèl API), `background/` (telechajman eta), `popup/`, `options/`, `folder/`.
