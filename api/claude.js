/*
 * /api/claude  —  jembatan ke Claude untuk menyusun outline dan kuis.
 *
 * Kunci API dibaca dari variabel lingkungan di sisi server dan TIDAK PERNAH
 * dikirim ke browser. Halaman hanya memanggil endpoint ini; endpoint yang
 * memegang kuncinya.
 *
 * Variabel lingkungan (atur di Vercel > Settings > Environment Variables):
 *
 *   ANTHROPIC_API_KEY   wajib. Ambil di console.anthropic.com, tempel di
 *                       dasbor Vercel. Jangan pernah menaruhnya di kode.
 *   AKUN_VERIFIKASI     JSON akun; lihat catatan bentuk di bawah.
 *   BATAS_AI_HARIAN     opsional, bawaan 30 permintaan per akun per hari.
 *   CLAUDE_MODEL        opsional, bawaan claude-opus-5.
 *   CLAUDE_EFFORT       opsional, bawaan medium. Naikkan ke high kalau
 *                       hasilnya kurang teliti dan fungsinya belum kehabisan
 *                       waktu; turunkan ke low kalau sering timeout.
 *   KV_REST_API_URL     opsional. Kalau ada, dipakai untuk kuota harian.
 *   KV_REST_API_TOKEN   Tanpa KV, endpoint tetap jalan tapi tanpa kuota.
 *
 * Bentuk AKUN_VERIFIKASI menerima dua gaya:
 *   {"dina": "<sha256>"}                          -> hanya untuk batas perangkat
 *   {"dina": {"h":"<sha256>", "ai":true}}         -> "ai":true memberi izin
 *                                                    memakai endpoint ini
 * Tanpa "ai":true sebuah akun tidak bisa memanggil Claude, jadi biaya API
 * tetap di tangan pemilik.
 */

var KUNCI_API = process.env.ANTHROPIC_API_KEY || "";
var MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
var EFFORT = process.env.CLAUDE_EFFORT || "medium";

/* Gemini sebagai penyedia alternatif. Nama variabelnya dibuat longgar
   karena orang menamainya bermacam-macam saat menempel di Vercel. */
var KUNCI_GEMINI = process.env.GEMINI_API_KEY ||
                   process.env.GOOGLE_API_KEY ||
                   process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
                   process.env.GOOGLE_AI_API_KEY || "";
var MODEL_GEMINI = process.env.GEMINI_MODEL || "gemini-2.5-pro";

/* Kalau dua-duanya terpasang, AI_PENYEDIA yang menentukan. Kalau tidak
   diisi, yang ada kuncinya yang dipakai \u2014 Anthropic lebih dulu. */
var PENYEDIA = (function () {
  var pilih = String(process.env.AI_PENYEDIA || "").toLowerCase();
  if (pilih === "gemini" && KUNCI_GEMINI) return "gemini";
  if (pilih === "claude" && KUNCI_API) return "claude";
  if (KUNCI_API) return "claude";
  if (KUNCI_GEMINI) return "gemini";
  return "";
})();

var NAMA_AI = PENYEDIA === "gemini" ? "Gemini" : "Claude";

/* Skema JSON kita memakai additionalProperties, yang ditolak Gemini.
   Buang kunci yang tidak dikenalnya, jangan kirim apa adanya. */
function skemaGemini(x) {
  if (Array.isArray(x)) return x.map(skemaGemini);
  if (!x || typeof x !== "object") return x;
  var keluar = {};
  Object.keys(x).forEach(function (k) {
    if (k === "additionalProperties" || k === "$schema") return;
    keluar[k] = skemaGemini(x[k]);
  });
  return keluar;
}
var BATAS_HARIAN = parseInt(process.env.BATAS_AI_HARIAN || "30", 10) || 30;
var MAKS_MASUKAN = 60000;

var URL_KV = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
var TOKEN_KV = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

function daftarAkun() {
  try {
    var j = JSON.parse(process.env.AKUN_VERIFIKASI || "{}");
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    return {};
  }
}

// Menerima bentuk lama (string hash) maupun bentuk objek.
function normalAkun(nilai) {
  if (typeof nilai === "string") return { h: nilai, ai: false };
  if (nilai && typeof nilai === "object") {
    return { h: String(nilai.h || ""), ai: nilai.ai === true };
  }
  return null;
}

function samaAman(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var beda = 0;
  for (var i = 0; i < a.length; i++) beda |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return beda === 0;
}

async function redis(perintah) {
  var r = await fetch(URL_KV, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN_KV, "Content-Type": "application/json" },
    body: JSON.stringify(perintah)
  });
  if (!r.ok) throw new Error("KV menjawab " + r.status);
  var j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function hariIni() {
  var d = new Date();
  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
}

/* Kuota harian per akun. Tanpa KV, tidak dibatasi. */
/* Sumber kebenaran akun adalah sesi di penyimpanan, sama seperti
   /api/data. AKUN_VERIFIKASI dulu dipakai di sini, tapi itu peninggalan
   mode bundel luring: nilainya harus ditempel manual tiap menambah akun,
   dan pembuatnya butuh sandi polos yang tidak ada lagi di mode server. */
async function akunDariToken(token) {
  if (!token || typeof token !== "string" || token.length !== 64) return null;
  var pengguna = await redis(["GET", "sesi:" + token]);
  if (!pengguna) return null;
  var mentah = await redis(["GET", "akun:" + pengguna]);
  if (!mentah) return null;
  var a;
  try { a = JSON.parse(mentah); } catch (e) { return null; }
  if (!a || a.aktif === false) return null;
  if (a.exp && a.exp < new Date().toISOString().slice(0, 10)) return null;
  return a;
}

async function ambilKuota(akun) {
  if (!URL_KV || !TOKEN_KV) return { ok: true, tanpaKuota: true };
  var kunci = "ai:" + akun + ":" + hariIni();
  var pakai = await redis(["INCR", kunci]);
  if (pakai === 1) await redis(["EXPIRE", kunci, 172800]);
  if (pakai > BATAS_HARIAN) {
    return { ok: false, pakai: pakai, batas: BATAS_HARIAN };
  }
  return { ok: true, pakai: pakai, batas: BATAS_HARIAN };
}

/* Skema keluaran. Structured outputs membuat balasan dijamin JSON yang sah,
   jadi tidak perlu lagi menambal blok kode atau menebak formatnya. */
var SKEMA_ENTRI = {
  type: "object",
  properties: {
    entri: {
      type: "array",
      items: {
        type: "object",
        properties: {
          stase: { type: "string" },
          tipe: { type: "string", enum: ["materi", "outline", "kuis", "catatan", "biko"] },
          judul: { type: "string" },
          tag: { type: "array", items: { type: "string" } },
          sumber: { type: "string" },
          isi: { type: "string" },
          soal: {
            type: "array",
            items: {
              type: "object",
              properties: {
                q: { type: "string" },
                opsi: { type: "array", items: { type: "string" } },
                jawaban: { type: "integer" },
                penjelasan: { type: "string" }
              },
              required: ["q", "opsi", "jawaban", "penjelasan"],
              additionalProperties: false
            }
          }
        },
        required: ["stase", "tipe", "judul", "tag", "sumber", "isi", "soal"],
        additionalProperties: false
      }
    }
  },
  required: ["entri"],
  additionalProperties: false
};

var SKEMA_KLARIFIKASI = {
  type: "object",
  properties: {
    perbaikan: {
      type: "array",
      items: {
        type: "object",
        properties: {
          nomor: { type: "integer" },
          kunciBerubah: { type: "boolean" },
          kunciBaru: { type: "string" },
          penjelasan: { type: "string" }
        },
        required: ["nomor", "kunciBerubah", "kunciBaru", "penjelasan"],
        additionalProperties: false
      }
    }
  },
  required: ["perbaikan"],
  additionalProperties: false
};

var DASAR =
  "Kamu membantu seorang koas (mahasiswa kedokteran tahap profesi) di Indonesia " +
  "menyusun arsip belajarnya. Tulis dalam Bahasa Indonesia yang jelas dan padat, " +
  "memakai istilah klinis yang lazim dipakai di rumah sakit pendidikan Indonesia.\n\n" +
  "Isi ditulis dengan markdown ringkas yang didukung situsnya: '##' untuk subjudul, " +
  "'-' untuk daftar, '**tebal**', '*miring*', '`kode`', '> kutipan', dan tabel pipa.\n\n" +
  "Akurasi klinis lebih penting daripada kelengkapan. Kalau sumbernya tidak memuat " +
  "sesuatu, jangan mengarang; tulis apa adanya. Kalau ada yang menurutmu keliru di " +
  "materi aslinya, perbaiki dan sebutkan alasannya.";

/* OCR memakai kemampuan baca gambar Claude, bukan pustaka pengenal huruf.
   Untuk tulisan tangan dan istilah medis hasilnya jauh lebih baik, dan
   tidak ada pustaka 13 MB yang harus ikut diunduh pemakai. */
var SKEMA_OCR = {
  type: "object",
  properties: {
    teks: { type: "string" },
    catatan: { type: "string" }
  },
  required: ["teks"],
  additionalProperties: false
};

/* Model kerap membalas notasi matematika LaTeX yang tidak dirender di sini
   dan malah tampil sebagai deretan tanda dolar. Dilarang lewat pemicunya,
   lalu tetap dibersihkan lagi di bawah kalau ternyata lolos juga. */
var ATURAN_FORMAT = [
  "",
  "",
  "ATURAN PENULISAN (wajib):",
  "- JANGAN memakai LaTeX atau notasi matematika sama sekali. Dilarang keras membungkus",
  "  apa pun dengan $...$, \\(...\\), atau \\[...\\], dan dilarang menulis perintah seperti",
  "  \\ge, \\le, \\pm, \\times, \\rightarrow, \\frac, atau \\text.",
  "- Tulis lambangnya langsung: ≥ ≤ ± × → µ, atau pakai kata (\"minimal\", \"kurang dari\").",
  "  Contoh benar: \"MoCA-INA normal ≥ 28\"; \"HIS ≤ 4 mengarah ke Alzheimer\".",
  "- Rentang dan simpangan ditulis biasa: \"22,9 ± 6,6\"; \"7-10 hari\".",
  "- Pakai markdown saja: ## dan ### untuk judul, - untuk daftar, **tebal** untuk istilah",
  "  dan angka penting, tabel pipa untuk data berkolom.",
  "- Sub-poin dijorokkan DUA spasi di depan tanda hubungnya supaya bertingkat rapi:",
  "    - Antikoagulan",
  "      - Heparin: 80 unit/kg bolus",
  "      - Enoksaparin: 1 mg/kg tiap 12 jam",
  "- Jangan menulis kalimat pengantar seperti \"Berikut hasilnya\"; langsung isinya saja."
].join("\n");

var GANTI_LATEX = [
  [/\\(?:ge|geq)(?![a-zA-Z])/g, "≥"], [/\\(?:le|leq)(?![a-zA-Z])/g, "≤"],
  [/\\pm(?![a-zA-Z])/g, "±"], [/\\times(?![a-zA-Z])/g, "×"], [/\\div(?![a-zA-Z])/g, "÷"],
  [/\\(?:rightarrow|to)(?![a-zA-Z])/g, "→"], [/\\approx(?![a-zA-Z])/g, "≈"],
  [/\\neq(?![a-zA-Z])/g, "≠"], [/\\mu(?![a-zA-Z])/g, "µ"], [/\\alpha(?![a-zA-Z])/g, "α"],
  [/\\beta(?![a-zA-Z])/g, "β"], [/\\circ(?![a-zA-Z])/g, "°"],
  [/\\text\{([^}]*)\}/g, "$1"], [/\\mathrm\{([^}]*)\}/g, "$1"],
  [/\\%/g, "%"], [/\\,/g, " "]
];

function bersihLatex(teks) {
  if (typeof teks !== "string") return teks;
  if (teks.indexOf("$") === -1 && teks.indexOf("\\") === -1) return teks;
  var t = teks;
  t = t.replace(/\$\$([\s\S]*?)\$\$/g, "$1");
  t = t.replace(/\$([^$\n]{1,150}?)\$/g, "$1");
  t = t.replace(/\\\(([\s\S]*?)\\\)/g, "$1");
  t = t.replace(/\\\[([\s\S]*?)\\\]/g, "$1");
  GANTI_LATEX.forEach(function (g) { t = t.replace(g[0], g[1]); });
  return t;
}

function bersihDalam(nilai) {
  if (typeof nilai === "string") return bersihLatex(nilai);
  if (Array.isArray(nilai)) return nilai.map(bersihDalam);
  if (nilai && typeof nilai === "object") {
    var k = {};
    Object.keys(nilai).forEach(function (n) { k[n] = bersihDalam(nilai[n]); });
    return k;
  }
  return nilai;
}

/* ---- Mengambil isi tautan ----
   Model tidak bisa membuka tautan sendiri, jadi servernya yang mengambil
   lalu menyerahkan teksnya. Karena permintaan berangkat dari server,
   alamat internal harus ditutup: tanpa itu endpoint ini jadi jalan untuk
   mengintip jaringan dalam (SSRF). */
var TUAN_TERLARANG = /^(?:localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?|.*\.local|.*\.internal)$/i;

function urlAman(mentah) {
  var u;
  try { u = new URL(String(mentah || "").trim()); }
  catch (e) { return { galat: "Alamatnya tidak terbaca." }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { galat: "Hanya alamat http:// atau https:// yang bisa diambil." };
  }
  var tuan = u.hostname.replace(/^\[|\]$/g, "");
  if (TUAN_TERLARANG.test(tuan) || TUAN_TERLARANG.test(tuan + ".")) {
    return { galat: "Alamat itu mengarah ke jaringan internal, tidak diambil." };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tuan)) {
    var o = tuan.split(".").map(Number);
    if (o[0] === 10 || o[0] === 127 || o[0] === 0 ||
        (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
        (o[0] === 192 && o[1] === 168) ||
        (o[0] === 169 && o[1] === 254)) {
      return { galat: "Alamat itu mengarah ke jaringan internal, tidak diambil." };
    }
  }
  return { url: u.toString() };
}

function tagKeTeks(html) {
  var t = String(html || "");
  // Buang yang tidak pernah jadi bacaan, termasuk isinya.
  t = t.replace(/<(script|style|noscript|svg|nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  // Batas blok dijadikan baris baru supaya daftar dan paragraf tidak menyatu.
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article)>/gi, "\n");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<li[^>]*>/gi, "- ");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
       .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  t = t.replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

async function ambilTautan(mentah) {
  var cek = urlAman(mentah);
  if (cek.galat) return cek;
  if (/youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|instagram\.com/i.test(cek.url)) {
    return { galat: "Isi video tidak bisa dibaca dari tautannya. Pasang saja sebagai lampiran tautan di entrinya, atau unggah slide/transkripnya." };
  }

  var r;
  try {
    r = await fetch(cek.url, {
      redirect: "follow",
      headers: {
        // Sebagian situs menolak permintaan tanpa identitas peramban.
        "User-Agent": "Mozilla/5.0 (compatible; ArsipKoas/1.0)",
        "Accept": "text/html,application/pdf,text/plain;q=0.9"
      }
    });
  } catch (e) {
    return { galat: "Alamatnya tidak bisa dihubungi: " + String(e.message || e) };
  }
  if (!r.ok) return { galat: "Situsnya menjawab " + r.status + "." };

  // Pengalihan bisa mendarat di alamat internal, jadi diperiksa lagi.
  var akhir = urlAman(r.url || cek.url);
  if (akhir.galat) return akhir;

  var jenis = (r.headers.get("content-type") || "").toLowerCase();
  if (jenis.indexOf("application/pdf") !== -1) {
    var buf = await r.arrayBuffer();
    if (buf.byteLength > 3000000) {
      return { galat: "PDF di tautan itu lebih dari 3 MB. Unduh lalu unggah per bab." };
    }
    return { pdf: Buffer.from(buf).toString("base64"), sumber: akhir.url };
  }
  if (jenis && jenis.indexOf("text/") === -1 && jenis.indexOf("xml") === -1) {
    return { galat: "Jenis berkas di tautan itu tidak bisa dibaca (" + jenis.split(";")[0] + ")." };
  }

  var mentahTeks = await r.text();
  var judul = (mentahTeks.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  var teks = tagKeTeks(mentahTeks);
  if (teks.length < 200) {
    return { galat: "Halaman itu hampir tidak berisi teks yang bisa dibaca. Kemungkinan isinya dimuat lewat skrip atau terkunci berlangganan." };
  }
  return {
    teks: "SUMBER: " + akhir.url + (judul ? "\nJUDUL HALAMAN: " + tagKeTeks(judul) : "") +
          "\n\n" + teks.slice(0, MAKS_MASUKAN),
    sumber: akhir.url
  };
}

var SKEMA_RAPI = {
  type: "object",
  properties: { isi: { type: "string" }, catatan: { type: "string" } },
  required: ["isi"],
  additionalProperties: false
};

var TUGAS = {
  rapikan: {
    sistem: DASAR + "\n\nRapikan catatan markdown yang diberikan sesuai permintaan " +
      "penulisnya. ATURAN KERAS: jangan menambah fakta, angka, dosis, atau klaim " +
      "medis yang tidak ada di teks asli, dan jangan membuang informasi. Yang boleh " +
      "kamu ubah hanya susunan, penomoran, ejaan, tanda baca, dan format markdown " +
      "(## judul, daftar, **tebal**, tabel pipa). Kalau ada bagian yang tampak keliru " +
      "atau bertentangan, JANGAN diperbaiki diam-diam \u2014 biarkan apa adanya lalu " +
      "sebutkan di \"catatan\". Kembalikan seluruh teks hasil rapian di \"isi\", " +
      "bukan potongan atau ringkasan.",
    skema: SKEMA_RAPI, format: true
  },
  kuisDari: {
    sistem: DASAR + "\n\nUbah materi yang diberikan menjadi SATU entri bertipe \"kuis\" " +
      "bergaya UKMPPD.\n\n" +
      "BENTUK SOAL:\n" +
      "- Setiap soal berupa vignette klinis: usia dan jenis kelamin, keluhan utama dan " +
      "durasinya, temuan pemeriksaan fisik yang relevan (tanda vital bila menentukan), " +
      "lalu hasil penunjang bila perlu. Tutup dengan pertanyaan yang tegas: diagnosis " +
      "paling mungkin, tatalaksana awal, pemeriksaan penunjang berikutnya, atau " +
      "mekanisme yang mendasari.\n" +
      "- Lima pilihan (A-E). Pengecohnya harus masuk akal: diagnosis banding yang benar-benar " +
      "mirip, bukan pilihan asal yang jelas salah.\n" +
      "- Utamakan yang HIGH-YIELD: yang sering keluar di UKMPPD dan sering ditanya penguji, " +
      "bukan detail langka.\n" +
      "- Pakai istilah dan dosis yang lazim di Indonesia bila materinya menyebutkan.\n\n" +
      "PEMBAHASAN: terangkan kenapa kuncinya benar DAN kenapa tiap pengecoh salah, " +
      "singkat tapi berisi.\n\n" +
      "BATAS: hanya boleh memakai isi materi yang diberikan. Kalau materinya tidak cukup " +
      "untuk membuat soal yang layak, buat lebih sedikit soal — jangan mengarang fakta, " +
      "angka, atau dosis yang tidak ada di materi. Kolom \"isi\" diisi ringkasan satu " +
      "paragraf tentang cakupan kuis ini.",
    skema: SKEMA_ENTRI
  },
  bahasSoal: {
    sistem: DASAR + "\n\nDi bawah ini kumpulan soal beserta kunci dan pembahasannya. " +
      "Kelompokkan menurut PENYAKIT atau TOPIK yang diujikan, lalu untuk tiap penyakit " +
      "keluarkan SATU entri bertipe \"outline\".\n\n" +
      "Susunan tiap outline:\n" +
      "## Definisi\n## Patofisiologi ringkas\n## Manifestasi klinis\n" +
      "## Diagnosis (termasuk kriteria dan penunjang kunci)\n## Diagnosis banding\n" +
      "## Tatalaksana\n## Yang sering ditanya penguji\n## Rujukan\n\n" +
      "ATURAN RUJUKAN — INI PALING PENTING:\n" +
      "- JANGAN PERNAH mengarang rujukan. Dilarang keras menulis DOI, nomor halaman, " +
      "nomor volume, tahun terbit, atau judul artikel yang tidak kamu yakini benar.\n" +
      "- Tulis rujukan pada tingkat yang memang kamu yakini, misalnya nama buku ajar " +
      "standar (\"Harrison's Principles of Internal Medicine\"), nama bab StatPearls " +
      "(\"StatPearls: Septic Shock\"), atau nama panduan organisasi profesi " +
      "(\"Surviving Sepsis Campaign\", \"PPK PERKI\", \"Pedoman Nasional Pelayanan Kedokteran\").\n" +
      "- Kalau ragu, tulis jenis sumbernya saja tanpa detail. Lebih baik tidak lengkap " +
      "daripada salah.\n" +
      "- Tutup bagian Rujukan dengan baris persis: " +
      "\"*Rujukan di atas adalah penunjuk arah, wajib diperiksa sendiri sebelum dikutip.*\"\n\n" +
      "Jangan menambah penyakit yang tidak muncul di soal-soal itu.",
    skema: SKEMA_ENTRI
  },
  ocr: {
    sistem: DASAR + "\n\nSalin SELURUH teks yang terbaca pada gambar atau dokumen " +
      "yang dilampirkan, apa adanya, tanpa merangkum dan tanpa menambah apa pun. " +
      "Pertahankan urutan bacanya, dan jaga struktur seperti judul, penomoran, dan " +
      "butir daftar memakai markdown sederhana. Untuk tabel, tulis ulang sebagai " +
      "tabel markdown. Kalau ada bagian yang tidak terbaca jelas, tulis [tidak " +
      "terbaca] di posisinya, jangan ditebak. Isi \"catatan\" hanya bila ada hal " +
      "yang perlu diketahui pembaca, misalnya tulisan terpotong atau buram; kalau " +
      "tidak ada, kosongkan.",
    skema: SKEMA_OCR
  },
  outline: {
    sistem: DASAR + "\n\nSusun materi yang diberikan menjadi SATU entri bertipe " +
      "\"outline\": definisi, patofisiologi ringkas, pendekatan diagnosis, diagnosis " +
      "banding, tatalaksana, dan hal yang sering ditanyakan pembimbing saat visite. " +
      "Tandai bagian high-yield untuk ujian dengan **tebal**. Kosongkan larik soal.",
    skema: SKEMA_ENTRI
  },
  kuis: {
    sistem: DASAR + "\n\nUbah latihan soal yang diberikan menjadi SATU entri bertipe " +
      "\"kuis\". Isi larik soal; \"jawaban\" adalah indeks mulai dari 0 pada larik " +
      "\"opsi\". Periksa ulang setiap kunci: kalau kunci di soal aslinya keliru, " +
      "perbaiki dan jelaskan di pembahasan. Setiap pembahasan harus menerangkan " +
      "kenapa kuncinya benar DAN kenapa opsi lain salah. Kolom \"isi\" diisi ringkasan " +
      "satu paragraf tentang cakupan kuis ini.",
    skema: SKEMA_ENTRI
  },
  klarifikasi: {
    sistem: DASAR + "\n\nDi bawah ini beberapa soal beserta kunci dan pembahasan yang " +
      "ditandai perlu diklarifikasi. Periksa ketepatan tiap butir. Untuk tiap nomor, " +
      "kembalikan pembahasan versi perbaikan. Kalau kuncinya memang keliru, set " +
      "\"kunciBerubah\" true dan tulis huruf kunci yang benar di \"kunciBaru\"; " +
      "kalau kuncinya sudah benar, set false dan kosongkan \"kunciBaru\".",
    skema: SKEMA_KLARIFIKASI
  }
};

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ galat: "Metode tidak didukung." });
  }

  if (!PENYEDIA) {
    return res.status(200).json({
      mati: true,
      catatan: "Belum ada kunci AI. Atur ANTHROPIC_API_KEY atau GEMINI_API_KEY di Vercel."
    });
  }

  var akunSah = daftarAkun();
  var adaSesi = !!(URL_KV && TOKEN_KV);
  if (!adaSesi && !Object.keys(akunSah).length) {
    return res.status(200).json({
      mati: true,
      catatan: "Penyimpanan (KV_REST_API_URL) belum diatur, dan AKUN_VERIFIKASI juga kosong."
    });
  }

  var b = req.body || {};
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }

  var token = String(b.token || "").slice(0, 80);
  var akun = String(b.akun || "").slice(0, 64).toLowerCase();
  var verifikasi = String(b.verifikasi || "").slice(0, 80);
  var tugas = String(b.tugas || "").slice(0, 20);
  var materi = String(b.materi || "");

  /* Pemeriksaan mandiri. Pemakai tidak bisa melihat log Vercel, jadi
     endpointnya sendiri yang melaporkan langkah mana yang putus. */
  if (tugas === "cek") {
    var lap = {
      penyedia: PENYEDIA || "(belum ada kunci API)",
      model: PENYEDIA === "gemini" ? MODEL_GEMINI : MODEL,
      kunciApi: PENYEDIA ? "terpasang" : "TIDAK ADA",
      penyimpanan: (URL_KV && TOKEN_KV) ? "terpasang" : "TIDAK ADA (KV_REST_API_URL)",
      sesi: "belum diperiksa",
      izinAi: "belum diperiksa",
      panggilanUji: "belum diperiksa"
    };

    if (!token) lap.sesi = "TIDAK ADA TOKEN \u2014 keluar lalu masuk lagi";
    else if (!(URL_KV && TOKEN_KV)) lap.sesi = "tidak bisa diperiksa tanpa penyimpanan";
    else {
      var au = null;
      try { au = await akunDariToken(token); }
      catch (e) { lap.sesi = "GAGAL menghubungi penyimpanan: " + String(e.message || e); }
      if (au) {
        lap.sesi = "sah, akun " + au.pengguna;
        lap.izinAi = au.ai === true ? "ya" : "TIDAK \u2014 nyalakan di Atur > Akun";
      } else if (lap.sesi === "belum diperiksa") {
        lap.sesi = "TOKEN TIDAK BERLAKU \u2014 keluar lalu masuk lagi";
      }
    }

    if (PENYEDIA && lap.izinAi === "ya") {
      try {
        if (PENYEDIA === "gemini") {
          var ru = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/" +
              encodeURIComponent(MODEL_GEMINI) + ":generateContent",
            { method: "POST",
              headers: { "x-goog-api-key": KUNCI_GEMINI, "content-type": "application/json" },
              body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "balas: ok" }] }] }) });
          var ju = await ru.json();
          lap.panggilanUji = ru.ok ? "BERHASIL"
            : "GAGAL " + ru.status + ": " + ((ju.error && ju.error.message) || "tidak diketahui");

          /* Nama model yang tersedia berbeda-beda per kunci dan berubah
             seiring model lama dipensiunkan, jadi jangan ditebak: tanyakan
             langsung ke Google dan tunjukkan daftarnya. */
          if (!ru.ok) {
            try {
              var rl = await fetch(
                "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100",
                { headers: { "x-goog-api-key": KUNCI_GEMINI } });
              var jl = await rl.json();
              if (rl.ok && Array.isArray(jl.models)) {
                lap.modelTersedia = jl.models.filter(function (m) {
                  return (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1;
                }).map(function (m) {
                  return String(m.name || "").replace(/^models\//, "");
                }).filter(function (n) {
                  // Varian khusus (embedding, TTS, live) bukan untuk tugas ini.
                  return n && !/embedding|aqa|tts|image|live|native-audio/.test(n);
                });
              } else {
                lap.modelTersedia = ["(gagal mengambil daftar: " +
                  ((jl.error && jl.error.message) || rl.status) + ")"];
              }
            } catch (e) {
              lap.modelTersedia = ["(gagal mengambil daftar: " + String(e.message || e) + ")"];
            }
          }
        } else {
          var ra = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": KUNCI_API, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "balas: ok" }] })
          });
          var ja = await ra.json();
          lap.panggilanUji = ra.ok ? "BERHASIL"
            : "GAGAL " + ra.status + ": " + ((ja.error && ja.error.message) || "tidak diketahui");
        }
      } catch (e) {
        lap.panggilanUji = "GAGAL: " + String(e.message || e);
      }
    }
    return res.status(200).json({ laporan: lap });
  }

  if (!TUGAS[tugas]) {
    return res.status(400).json({ galat: "Permintaan tidak lengkap." });
  }
  if (!token && (!akun || !verifikasi)) {
    return res.status(401).json({ galat: "Masuk dulu sebelum memakai AI." });
  }
  var adaLampiran = Array.isArray(b.lampiran) && b.lampiran.length > 0;
  var tautan = String(b.tautan || "").trim();
  if (!materi.trim() && !adaLampiran && !tautan) {
    return res.status(400).json({ galat: "Materinya masih kosong." });
  }
  if (!materi.trim()) {
    materi = "Susun dari berkas yang dilampirkan.";
  }
  if (materi.length > MAKS_MASUKAN) {
    return res.status(400).json({
      galat: "Materi terlalu panjang (" + Math.round(materi.length / 1000) + " ribu karakter, " +
        "batas " + Math.round(MAKS_MASUKAN / 1000) + " ribu). Potong jadi beberapa bagian."
    });
  }

  /* Lampiran diperiksa sebelum apa pun dikirim ke Anthropic: hanya jenis
     yang memang bisa dibaca model, dan totalnya harus muat di badan
     permintaan Vercel. Video tidak pernah lolos \u2014 Messages API tidak
     bisa menontonnya, dan menerimanya diam-diam cuma membuang kuota. */
  var lampiran = Array.isArray(b.lampiran) ? b.lampiran : [];
  if (lampiran.length > 8) {
    return res.status(400).json({ galat: "Maksimal 8 lampiran sekali kirim." });
  }
  var MIME_GAMBAR = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  var totalLampiran = 0;
  for (var i = 0; i < lampiran.length; i++) {
    var lp = lampiran[i] || {};
    var data = typeof lp.data === "string" ? lp.data : "";
    if (!data) return res.status(400).json({ galat: "Ada lampiran tanpa isi." });
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) {
      return res.status(400).json({ galat: "Lampiran bukan base64 yang sah." });
    }
    var mime = String(lp.mime || "");
    if (lp.jenis === "gambar") {
      if (MIME_GAMBAR.indexOf(mime) === -1) {
        return res.status(400).json({ galat: "Jenis gambar tidak didukung: " + mime });
      }
    } else if (lp.jenis === "pdf") {
      if (mime !== "application/pdf") {
        return res.status(400).json({ galat: "Lampiran PDF salah jenis: " + mime });
      }
    } else {
      return res.status(400).json({ galat: "Jenis lampiran tidak dikenal." });
    }
    totalLampiran += data.length;
  }
  // Vercel menolak badan permintaan di atas 4,5 MB sebelum kode ini jalan,
  // jadi plafonnya ditaruh sedikit di bawah itu agar pesannya jelas dan
  // bukan galat jaringan yang membingungkan.
  if (totalLampiran > 4300000) {
    return res.status(400).json({
      galat: "Total lampiran melebihi batas permintaan Vercel (4,5 MB). " +
        "Kirim beberapa kali, atau pasang berkas besar sebagai tautan lampiran di entrinya."
    });
  }

  /* Jalur utama: token sesi. Jalur AKUN_VERIFIKASI dipertahankan supaya
     pemasangan lama tanpa penyimpanan tetap jalan, tapi tidak lagi wajib. */
  var bolehAi = false;
  if (token && adaSesi) {
    var akunSesi = null;
    try { akunSesi = await akunDariToken(token); }
    catch (e) { return res.status(502).json({ galat: "Penyimpanan tidak bisa dihubungi." }); }
    if (!akunSesi) {
      return res.status(401).json({ galat: "Sesi tidak berlaku, masuk lagi." });
    }
    akun = akunSesi.pengguna;
    bolehAi = akunSesi.ai === true;
  } else {
    var info = normalAkun(akunSah[akun]);
    if (!info || !samaAman(verifikasi, info.h)) {
      return res.status(401).json({ galat: "Akun tidak dikenali." });
    }
    bolehAi = info.ai;
  }

  if (!bolehAi) {
    return res.status(403).json({
      galat: "Akun ini belum diberi izin memakai " + NAMA_AI +
        ". Pemilik bisa menyalakannya lewat menu Atur \u2192 Akun."
    });
  }

  try {
    var kuota = await ambilKuota(akun);
    if (!kuota.ok) {
      return res.status(429).json({
        galat: "Kuota harian habis (" + kuota.batas + " permintaan). Coba lagi besok."
      });
    }

    var t = TUGAS[tugas];
    var dariTautan = null;
    if (tautan) {
      var hasilTautan = await ambilTautan(tautan);
      if (hasilTautan.galat) return res.status(400).json({ galat: hasilTautan.galat });
      if (hasilTautan.pdf) {
        // PDF dari tautan diperlakukan sama seperti PDF yang diunggah.
        lampiran = lampiran.concat([{ jenis: "dokumen", mime: "application/pdf", data: hasilTautan.pdf }]);
        materi = (materi ? materi + "\n\n" : "") + "Sumber: " + hasilTautan.sumber;
      } else {
        materi = (materi ? materi + "\n\n---\n" : "") + hasilTautan.teks;
      }
      dariTautan = hasilTautan.sumber;
      if (materi.length > MAKS_MASUKAN) materi = materi.slice(0, MAKS_MASUKAN);
    }
    // Aturan penulisan ditempel ke semua tugas, bukan disalin satu per satu
    // ke tiap pemicu, supaya tidak ada yang terlewat saat menambah tugas.
    var sistemPakai = t.sistem + ATURAN_FORMAT;

    // Lampiran: gambar (foto slide, papan tulis, halaman buku) dan PDF
    // dibaca langsung oleh model. PPT dan Word sudah diubah jadi teks di
    // sisi browser, jadi tidak pernah sampai ke sini sebagai berkas.
    var teks = "";
    var pemakaian = null;

    if (PENYEDIA === "gemini") {
      // Gemini menerima gambar dan PDF lewat inline_data dengan muatan
      // base64 yang sama persis, jadi lampirannya tidak perlu diolah ulang.
      var bagian = [];
      for (var gi = 0; gi < lampiran.length; gi++) {
        var lg = lampiran[gi];
        bagian.push({
          inline_data: {
            mime_type: lg.jenis === "gambar" ? lg.mime : "application/pdf",
            data: lg.data
          }
        });
      }
      bagian.push({ text: materi });

      var badanG = {
        contents: [{ role: "user", parts: bagian }],
        systemInstruction: { parts: [{ text: sistemPakai }] },
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: skemaGemini(t.skema),
          maxOutputTokens: 16000
        }
      };

      var rg = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(MODEL_GEMINI) + ":generateContent",
        {
          method: "POST",
          headers: {
            "x-goog-api-key": KUNCI_GEMINI,
            "content-type": "application/json"
          },
          body: JSON.stringify(badanG)
        }
      );
      var jg = await rg.json();

      if (!rg.ok) {
        // Pesan aslinya diteruskan: kalau nama modelnya salah, di situlah
        // satu-satunya petunjuk yang berguna buat pemakai.
        var pesanG = (jg && jg.error && jg.error.message) || ("Gemini menjawab " + rg.status);
        return res.status(502).json({
          galat: pesanG + (rg.status === 404
            ? " (ganti nama modelnya lewat variabel GEMINI_MODEL di Vercel)" : "")
        });
      }
      if (jg.promptFeedback && jg.promptFeedback.blockReason) {
        return res.status(200).json({
          galat: "Gemini menolak memproses materi ini (" + jg.promptFeedback.blockReason + ")."
        });
      }

      var kandidat = (jg.candidates || [])[0];
      if (!kandidat) {
        return res.status(502).json({ galat: "Gemini tidak mengembalikan jawaban." });
      }
      if (kandidat.finishReason === "MAX_TOKENS") {
        return res.status(200).json({
          galat: "Jawabannya terpotong karena terlalu panjang. Potong materinya jadi beberapa bagian."
        });
      }
      if (kandidat.finishReason === "SAFETY" || kandidat.finishReason === "PROHIBITED_CONTENT") {
        return res.status(200).json({ galat: "Gemini menolak memproses materi ini." });
      }
      ((kandidat.content && kandidat.content.parts) || []).forEach(function (bg) {
        if (typeof bg.text === "string") teks += bg.text;
      });
      if (jg.usageMetadata) {
        pemakaian = jg.usageMetadata.promptTokenCount + " masuk / " +
                    jg.usageMetadata.candidatesTokenCount + " keluar";
      }

    } else {
      // Lampiran: gambar (foto slide, papan tulis, halaman buku) dan PDF
      // dibaca langsung oleh model. PPT dan Word sudah diubah jadi teks di
      // sisi browser, jadi tidak pernah sampai ke sini sebagai berkas.
      var isiPesan = [];
      for (var li = 0; li < lampiran.length; li++) {
        var lp = lampiran[li];
        if (lp.jenis === "gambar") {
          isiPesan.push({
            type: "image",
            source: { type: "base64", media_type: lp.mime, data: lp.data }
          });
        } else {
          isiPesan.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: lp.data }
          });
        }
      }
      isiPesan.push({ type: "text", text: materi });

      var badan = {
        model: MODEL,
        max_tokens: 16000,
        system: sistemPakai,
        output_config: {
          effort: EFFORT,
          format: { type: "json_schema", schema: t.skema }
        },
        messages: [{ role: "user", content: isiPesan }]
      };

      var r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": KUNCI_API,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify(badan)
      });

      var j = await r.json();

      if (!r.ok) {
        var pesan = (j && j.error && j.error.message) || ("Claude menjawab " + r.status);
        return res.status(502).json({ galat: pesan });
      }

      // Klasifikasi keamanan bisa menolak; cek sebelum membaca isi.
      if (j.stop_reason === "refusal") {
        return res.status(200).json({
          galat: "Claude menolak memproses materi ini." +
            (j.stop_details && j.stop_details.category ? " (" + j.stop_details.category + ")" : "")
        });
      }
      if (j.stop_reason === "max_tokens") {
        return res.status(200).json({
          galat: "Jawabannya terpotong karena terlalu panjang. Potong materinya jadi beberapa bagian."
        });
      }

      (j.content || []).forEach(function (blok) {
        if (blok.type === "text") teks += blok.text;
      });
      if (j.usage) {
        pemakaian = j.usage.input_tokens + " masuk / " + j.usage.output_tokens + " keluar";
      }
    }

    var hasil;
    try { hasil = bersihDalam(JSON.parse(teks)); }
    catch (e) {
      return res.status(502).json({ galat: "Balasan " + NAMA_AI + " tidak terbaca sebagai JSON." });
    }

    return res.status(200).json({
      hasil: hasil,
      penyedia: NAMA_AI,
      dariTautan: dariTautan,
      pakai: kuota.pakai,
      batas: kuota.tanpaKuota ? null : kuota.batas,
      token: pemakaian
    });

  } catch (err) {
    return res.status(500).json({ galat: String((err && err.message) || err) });
  }
};
