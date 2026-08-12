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

var TUGAS = {
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
  if (!Object.keys(akunSah).length) {
    return res.status(200).json({ mati: true, catatan: "AKUN_VERIFIKASI belum diatur." });
  }

  var b = req.body || {};
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }

  var akun = String(b.akun || "").slice(0, 64).toLowerCase();
  var verifikasi = String(b.verifikasi || "").slice(0, 80);
  var tugas = String(b.tugas || "").slice(0, 20);
  var materi = String(b.materi || "");

  if (!akun || !verifikasi || !TUGAS[tugas]) {
    return res.status(400).json({ galat: "Permintaan tidak lengkap." });
  }
  var adaLampiran = Array.isArray(b.lampiran) && b.lampiran.length > 0;
  if (!materi.trim() && !adaLampiran) {
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

  var info = normalAkun(akunSah[akun]);
  if (!info || !samaAman(verifikasi, info.h)) {
    return res.status(401).json({ galat: "Akun tidak dikenali." });
  }
  if (!info.ai) {
    return res.status(403).json({ galat: "Akun ini tidak diberi izin memakai " + NAMA_AI + "." });
  }

  try {
    var kuota = await ambilKuota(akun);
    if (!kuota.ok) {
      return res.status(429).json({
        galat: "Kuota harian habis (" + kuota.batas + " permintaan). Coba lagi besok."
      });
    }

    var t = TUGAS[tugas];

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
        systemInstruction: { parts: [{ text: t.sistem }] },
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
        system: t.sistem,
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
    try { hasil = JSON.parse(teks); }
    catch (e) {
      return res.status(502).json({ galat: "Balasan " + NAMA_AI + " tidak terbaca sebagai JSON." });
    }

    return res.status(200).json({
      hasil: hasil,
      penyedia: NAMA_AI,
      pakai: kuota.pakai,
      batas: kuota.tanpaKuota ? null : kuota.batas,
      token: pemakaian
    });

  } catch (err) {
    return res.status(500).json({ galat: String((err && err.message) || err) });
  }
};
