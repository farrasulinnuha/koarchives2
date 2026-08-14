/*
 * /api/data  —  otak server untuk Arsip Koas.
 *
 * Semua yang penting hidup di sini, bukan di browser:
 *   - daftar akun beserta perannya
 *   - isi arsip (entri, stase, teks situs, tema)
 *   - data pribadi tiap akun (tracker IPK, skor kuis, latar)
 *
 * Akibatnya: buka di laptop mana pun isinya sama, konten berbayar benar-benar
 * tidak dikirim ke yang belum login, menambah akun tidak perlu menerbitkan
 * ulang situs, dan memperbarui berkas situs TIDAK menyentuh data sama sekali.
 *
 * Variabel lingkungan (Vercel > Settings > Environment Variables):
 *   KV_REST_API_URL     wajib \  dari integrasi Upstash Redis
 *   KV_REST_API_TOKEN   wajib /
 *   PEMILIK_AWAL        wajib sekali di awal, bentuk "pengguna:sandi".
 *                       Dipakai hanya kalau belum ada akun sama sekali.
 *                       Hapus variabelnya setelah akun pemilik terbentuk.
 *
 * Peran:
 *   pemilik      atur situs, kelola akun, terbitkan, hapus
 *   kontributor  kirim entri, menunggu persetujuan pemilik
 *   pengakses    hanya membaca
 *
 * Tingkat akses: "penuh" (semua materi) atau "publik" (hanya materi gratis).
 */

var crypto = require("crypto");

var URL_KV = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
var TOKEN_KV = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
var PEMILIK_AWAL = process.env.PEMILIK_AWAL || "";

var UMUR_SESI = 60 * 60 * 24 * 30; // 30 hari
var PUTARAN = 210000;

/* ---------------------------------------------------------------- Redis */

async function redis(perintah) {
  var r = await fetch(URL_KV, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN_KV, "Content-Type": "application/json" },
    body: JSON.stringify(perintah)
  });
  if (!r.ok) throw new Error("Penyimpanan menjawab " + r.status);
  var j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

async function ambil(kunci, bawaan) {
  var v = await redis(["GET", kunci]);
  if (v === null || v === undefined) return bawaan;
  try { return JSON.parse(v); } catch (e) { return bawaan; }
}
async function simpan(kunci, nilai) {
  return redis(["SET", kunci, JSON.stringify(nilai)]);
}

/* ------------------------------------------------------------ Kata sandi */

function acakHex(n) { return crypto.randomBytes(n).toString("hex"); }

function olahSandi(sandi, garamHex) {
  return crypto.pbkdf2Sync(String(sandi), Buffer.from(garamHex, "hex"),
    PUTARAN, 32, "sha256").toString("hex");
}

function samaAman(a, b) {
  var ba = Buffer.from(String(a));
  var bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function normalPengguna(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 64);
}

/* --------------------------------------------------------------- Akun */

async function daftarPengguna() { return ambil("akun:daftar", []); }

async function bacaAkun(pengguna) {
  if (!pengguna) return null;
  return ambil("akun:" + pengguna, null);
}

function akunAman(a) {
  if (!a) return null;
  return {
    pengguna: a.pengguna, nama: a.nama, peran: a.peran,
    tingkat: a.tingkat, exp: a.exp || "", aktif: a.aktif !== false,
    ai: a.ai === true, dibuat: a.dibuat || "", mandiri: a.mandiri === true,
    surel: a.surel || "", asalMasuk: a.asalMasuk || "",
    universitas: a.universitas || "", angkatan: a.angkatan || "", grup: a.grup || "",
    nim: a.nim || "", staseKini: a.staseKini || "", rsKini: a.rsKini || "",
    telepon: a.telepon || "", bio: a.bio || ""
  };
}

async function tulisAkun(a) {
  await simpan("akun:" + a.pengguna, a);
  var daftar = await daftarPengguna();
  if (daftar.indexOf(a.pengguna) === -1) {
    daftar.push(a.pengguna);
    await simpan("akun:daftar", daftar);
  }
}

/* Akun pemilik pertama dibuat dari PEMILIK_AWAL, hanya bila belum ada akun. */
async function siapkanPemilik() {
  var daftar = await daftarPengguna();
  if (daftar.length) return null;
  if (!PEMILIK_AWAL || PEMILIK_AWAL.indexOf(":") === -1) return null;

  var potong = PEMILIK_AWAL.indexOf(":");
  var pengguna = normalPengguna(PEMILIK_AWAL.slice(0, potong));
  var sandi = PEMILIK_AWAL.slice(potong + 1);
  if (pengguna.length < 3 || sandi.length < 6) return null;

  var garam = acakHex(16);
  var akun = {
    pengguna: pengguna, nama: pengguna, peran: "pemilik", tingkat: "penuh",
    garam: garam, hash: olahSandi(sandi, garam),
    exp: "", aktif: true, ai: true, dibuat: new Date().toISOString().slice(0, 10)
  };
  await tulisAkun(akun);
  return akun;
}

/* ------------------------------------------------------- Masuk pihak luar */

var GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
var SSO_CAS = (process.env.SSO_CAS_URL || "").replace(/\/+$/, "");
var SSO_NAMA = process.env.SSO_NAMA || "SSO kampus";
var SSO_SUREL = (process.env.SSO_SUREL_DOMAIN || "").toLowerCase();

var jwksSimpan = { pada: 0, kunci: {} };

async function kunciGoogle(kid) {
  // Kunci Google berputar; disimpan sebentar supaya tidak diambil tiap masuk.
  if (Date.now() - jwksSimpan.pada > 3600000 || !jwksSimpan.kunci[kid]) {
    var r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!r.ok) throw new Error("Tidak bisa mengambil kunci Google.");
    var j = await r.json();
    var peta = {};
    (j.keys || []).forEach(function (k) { peta[k.kid] = k; });
    jwksSimpan = { pada: Date.now(), kunci: peta };
  }
  return jwksSimpan.kunci[kid] || null;
}

function dariB64Url(t) { return Buffer.from(String(t), "base64url"); }

/* Memeriksa ID token Google sampai ke tanda tangannya. Tanpa langkah ini
   siapa pun bisa mengarang token dan masuk sebagai siapa saja. */
async function periksaGoogle(idToken) {
  if (!GOOGLE_CLIENT_ID) return { galat: "Masuk dengan Google belum diatur di server." };
  var bagian = String(idToken || "").split(".");
  if (bagian.length !== 3) return { galat: "Token Google tidak berbentuk sah." };

  var kepala, muatan;
  try {
    kepala = JSON.parse(dariB64Url(bagian[0]).toString("utf8"));
    muatan = JSON.parse(dariB64Url(bagian[1]).toString("utf8"));
  } catch (e) { return { galat: "Token Google tidak terbaca." }; }
  if (kepala.alg !== "RS256") return { galat: "Algoritma token tidak didukung." };

  var jwk = await kunciGoogle(kepala.kid);
  if (!jwk) return { galat: "Kunci penanda tangan token tidak dikenali." };

  var sah;
  try {
    sah = crypto.createVerify("RSA-SHA256")
      .update(bagian[0] + "." + bagian[1])
      .verify(crypto.createPublicKey({ key: jwk, format: "jwk" }), dariB64Url(bagian[2]));
  } catch (e) { return { galat: "Tanda tangan token tidak bisa diperiksa." }; }
  if (!sah) return { galat: "Tanda tangan token tidak cocok." };

  if (muatan.aud !== GOOGLE_CLIENT_ID) return { galat: "Token ini bukan untuk aplikasi ini." };
  if (["accounts.google.com", "https://accounts.google.com"].indexOf(muatan.iss) === -1) {
    return { galat: "Penerbit token bukan Google." };
  }
  if (!muatan.exp || muatan.exp * 1000 < Date.now()) return { galat: "Token Google sudah kedaluwarsa." };
  if (muatan.email_verified !== true && muatan.email_verified !== "true") {
    return { galat: "Alamat surel Google itu belum terverifikasi." };
  }
  if (!muatan.email) return { galat: "Token tidak memuat alamat surel." };
  return { surel: String(muatan.email).toLowerCase(), nama: String(muatan.name || ""), sub: String(muatan.sub || "") };
}

/* CAS dipakai banyak SSO kampus, termasuk UGM. Alamat dasarnya diisi lewat
   SSO_CAS_URL supaya tidak dipatok di kode. */
async function periksaCas(tiket, layanan) {
  if (!SSO_CAS) return { galat: SSO_NAMA + " belum diatur di server." };
  if (!tiket) return { galat: "Tiket SSO kosong." };
  var alamat = SSO_CAS + "/serviceValidate?service=" + encodeURIComponent(layanan) +
               "&ticket=" + encodeURIComponent(tiket);
  var r;
  try { r = await fetch(alamat); }
  catch (e) { return { galat: "Server " + SSO_NAMA + " tidak bisa dihubungi." }; }
  var xml = await r.text();
  if (!/authenticationSuccess/i.test(xml)) {
    var sebab = (xml.match(/<cas:authenticationFailure[^>]*>([\s\S]*?)<\//i) || [])[1];
    return { galat: "Tiket SSO ditolak" + (sebab ? ": " + sebab.trim().slice(0, 120) : ".") };
  }
  var pengguna = (xml.match(/<cas:user>([\s\S]*?)<\/cas:user>/i) || [])[1];
  if (!pengguna) return { galat: "Balasan SSO tidak memuat identitas." };
  pengguna = pengguna.trim().toLowerCase();
  var surel = (xml.match(/<cas:(?:email|mail)>([\s\S]*?)<\/cas:(?:email|mail)>/i) || [])[1];
  var nama = (xml.match(/<cas:(?:nama|name|displayName|cn)>([\s\S]*?)<\/cas:(?:nama|name|displayName|cn)>/i) || [])[1];
  return {
    surel: (surel ? surel.trim() : (SSO_SUREL ? pengguna + "@" + SSO_SUREL : pengguna)).toLowerCase(),
    nama: nama ? nama.trim() : pengguna,
    sub: pengguna
  };
}

/* Satu jalur untuk kedua cara masuk: cari akun yang surelnya sudah
   ditautkan, kalau belum ada baru dibuatkan — dan hanya kalau
   pendaftaran mandiri memang sedang dibuka. */
async function masukLuar(profil, asal, req, res) {
  var indeks = await ambil("surel:" + profil.surel, null);
  var akunLuar = indeks ? await bacaAkun(indeks) : null;

  if (!akunLuar) {
    var bukaDaftarLuar = await ambil("atur:pendaftaran", false);
    if (bukaDaftarLuar !== true) {
      return res.status(403).json({
        galat: "Surel " + profil.surel + " belum terdaftar di arsip ini, dan pendaftaran sedang ditutup. " +
          "Minta pemilik arsip menautkan surel itu ke akunmu."
      });
    }
    var dasar = normalPengguna(profil.surel.split("@")[0]) || "akun";
    var calon = dasar;
    for (var i = 2; await bacaAkun(calon); i++) calon = dasar + i;
    akunLuar = {
      pengguna: calon,
      nama: profil.nama || calon,
      surel: profil.surel,
      garam: acakHex(16),
      hash: "",                 // masuk lewat penyedia luar, tidak punya sandi lokal
      asalMasuk: asal,
      peran: "pengakses", tingkat: "publik",
      exp: "", aktif: true, ai: false, mandiri: true,
      dibuat: new Date().toISOString().slice(0, 10)
    };
    await tulisAkun(akunLuar);
    await simpan("surel:" + profil.surel, akunLuar.pengguna);
  }

  if (akunLuar.aktif === false) return res.status(403).json({ galat: "Akun ini dinonaktifkan." });
  if (akunLuar.exp && akunLuar.exp < new Date().toISOString().slice(0, 10)) {
    return res.status(403).json({ galat: "Akun ini sudah lewat masa berlaku." });
  }

  var tokenLuar = await buatSesi(akunLuar.pengguna, jejakPermintaan(req));
  return res.status(200).json({
    token: tokenLuar, akun: akunAman(akunLuar),
    arsip: saringUntuk(await bacaArsip(), akunLuar),
    pribadi: await ambil("pribadi:" + akunLuar.pengguna, null)
  });
}

/* --------------------------------------------------------------- Sesi */

/* Satu akun hanya boleh punya SATU sesi hidup. Token lama dicabut begitu
   ada yang masuk lagi, jadi akun yang dijual-ulang saling melempar keluar
   dan tidak nyaman dipakai berbarengan. */
async function buatSesi(pengguna, jejak) {
  // Token lama sengaja TIDAK dihapus: dibiarkan hidup sebentar supaya
  // pemakainya menerima keterangan "dipakai di perangkat lain", bukan
  // sekadar terlempar tanpa penjelasan. Yang menentukan sah atau tidak
  // adalah sesiAktif di bawah, jadi ini tetap tertutup.
  var token = acakHex(32);
  await redis(["SET", "sesi:" + token, pengguna, "EX", String(UMUR_SESI)]);
  await redis(["SET", "sesiAktif:" + pengguna, token, "EX", String(UMUR_SESI)]);

  if (jejak) {
    await simpan("perangkat:" + pengguna, jejak);
    var riwayat = await ambil("riwayat:" + pengguna, []);
    if (!Array.isArray(riwayat)) riwayat = [];
    riwayat.unshift(jejak);
    // Cukup 20 terakhir; ini alat pemantau, bukan arsip.
    await simpan("riwayat:" + pengguna, riwayat.slice(0, 20));
  }
  return token;
}

/* Vercel menyisipkan tebakan lokasi di kepala permintaan, jadi tidak perlu
   layanan geo terpisah. Alamat IP-nya sendiri tidak disimpan utuh. */
function jejakPermintaan(req) {
  function amb(n) { return String(req.headers[n] || "").slice(0, 80); }
  var kota = amb("x-vercel-ip-city");
  try { kota = decodeURIComponent(kota); } catch (e) {}
  var ip = amb("x-forwarded-for").split(",")[0].trim();
  return {
    waktu: new Date().toISOString(),
    kota: kota || "",
    wilayah: amb("x-vercel-ip-country-region"),
    negara: amb("x-vercel-ip-country"),
    // Disimpan sebagai sidik, bukan alamat aslinya.
    ip: ip ? crypto.createHash("sha256").update(ip).digest("hex").slice(0, 12) : "",
    perangkat: /mobile|android|iphone|ipad/i.test(amb("user-agent")) ? "ponsel" : "komputer"
  };
}

async function akunDariToken(token) {
  if (!token || typeof token !== "string" || token.length !== 64) return null;
  var pengguna = await redis(["GET", "sesi:" + token]);
  if (!pengguna) return null;
  // Token boleh saja masih ada, tapi kalau bukan lagi yang aktif berarti
  // sudah digantikan oleh sesi di perangkat lain.
  var aktif = await redis(["GET", "sesiAktif:" + pengguna]);
  if (aktif && aktif !== token) return { tergusur: true };
  // Kalau penandanya sempat kedaluwarsa lebih dulu, token lama bisa hidup
  // lagi dan batas satu perangkat jebol. Umurnya diperpanjang bersamaan.
  if (!aktif) await redis(["SET", "sesiAktif:" + pengguna, token, "EX", String(UMUR_SESI)]);
  else await redis(["EXPIRE", "sesiAktif:" + pengguna, String(UMUR_SESI)]);
  var a = await bacaAkun(pengguna);
  if (!a || a.aktif === false) return null;
  if (a.exp && a.exp < new Date().toISOString().slice(0, 10)) return null;
  // Perpanjang selama masih dipakai.
  await redis(["EXPIRE", "sesi:" + token, String(UMUR_SESI)]);
  return a;
}

/* -------------------------------------------------------------- Arsip */

async function bacaArsip() {
  return {
    entri: await ambil("arsip:entri", []),
    stase: await ambil("arsip:stase", []),
    staseUbah: await ambil("arsip:staseUbah", []),
    staseGambar: await ambil("arsip:staseGambar", {}),
    teks: await ambil("arsip:teks", {}),
    berkas: await ambil("arsip:berkas", []),
    agenda: await ambil("arsip:agenda", []),
    ikon: await ambil("arsip:ikon", ""),
    tema: await ambil("arsip:tema", null),
    versi: await ambil("arsip:versi", 0)
  };
}

/* Yang dikirim ke klien disaring di server. Materi terbatas tidak pernah
   meninggalkan server untuk akun yang tidak berhak. */
function bolehLihat(e, akun) {
  if (!e) return false;
  var peran = akun ? akun.peran : "";
  var tingkat = akun ? akun.tingkat : "publik";
  if (peran === "pemilik") return true;
  // Penulisnya selalu boleh melihat tulisannya sendiri, apa pun status dan
  // tingkat aksesnya. Tanpa ini, kontributor bertingkat publik mengunggah
  // materi lalu kirimannya hilang dari pandangannya sendiri.
  if (peran === "kontributor" && akun && e.penulis === akun.pengguna) return true;
  if (e.status !== "terbit") return false;
  if (tingkat !== "penuh" && e.akses !== "publik") return false;
  return true;
}

function saringUntuk(arsip, akun) {
  // Satu sumber kebenaran dengan bolehLihat(), supaya izin daftar arsip dan
  // izin lampiran tidak bisa berbeda diam-diam.
  var terlihat = (arsip.entri || []).filter(function (e) { return bolehLihat(e, akun); });
  return Object.assign({}, arsip, { entri: terlihat });
}

/* Pengingat yang ditugaskan hidup di kunci sendiri, bukan di ember pribadi
   pembuatnya, karena harus terbaca oleh beberapa akun sekaligus. Yang boleh
   melihat cuma pembuat dan orang yang ditugaskan — bukan semua orang. */
async function bacaTugasan() {
  var t = await ambil("agenda:tugasan", []);
  return Array.isArray(t) ? t : [];
}

function tugasanUntuk(semua, akun) {
  if (!akun) return [];
  return semua.filter(function (t) {
    return t.pembuat === akun.pengguna ||
      (Array.isArray(t.untuk) && t.untuk.indexOf(akun.pengguna) !== -1);
  });
}

function bersihTugasan(t, akun, untukSah) {
  var jenis = ["jaga", "ujian", "tugas", "acara"].indexOf(t.jenis) !== -1 ? t.jenis : "acara";
  return {
    id: String(t.id || ("ag-" + acakHex(8))).slice(0, 64),
    judul: String(t.judul || "").slice(0, 200),
    tanggal: String(t.tanggal || "").slice(0, 10),
    jam: String(t.jam || "").slice(0, 5),
    jenis: jenis,
    catatan: String(t.catatan || "").slice(0, 400),
    // Pembuat selalu ditentukan server: tanpa ini siapa pun bisa mengirim
    // pengingat yang seolah dibuat orang lain.
    pembuat: akun.pengguna,
    untuk: untukSah
  };
}

function bersihEntri(e, akun) {
  var soal = Array.isArray(e.soal) ? e.soal.filter(function (s) {
    return s && typeof s.q === "string" && Array.isArray(s.opsi) && s.opsi.length >= 2;
  }).map(function (s) {
    var j = Number(s.jawaban);
    return {
      q: String(s.q), opsi: s.opsi.map(String),
      jawaban: (j >= 0 && j < s.opsi.length) ? j : 0,
      penjelasan: String(s.penjelasan || "")
    };
  }) : [];

  var tipe = ["materi", "outline", "kuis", "catatan", "biko"].indexOf(e.tipe) !== -1
    ? e.tipe : (soal.length ? "kuis" : "materi");

  return {
    id: String(e.id || ("e-" + acakHex(8))),
    stase: String(e.stase || "ipd"),
    tipe: tipe,
    akses: e.akses === "publik" ? "publik" : "terbatas",
    judul: String(e.judul || "").slice(0, 300),
    tanggal: String(e.tanggal || new Date().toISOString().slice(0, 10)),
    tag: Array.isArray(e.tag) ? e.tag.map(String).slice(0, 20) : [],
    sumber: String(e.sumber || "").slice(0, 500),
    lampiran: Array.isArray(e.lampiran) ? e.lampiran.slice(0, 20).map(function (l) {
      return {
        id: String(l.id || ("l-" + acakHex(6))),
        jenis: l.jenis === "berkas" ? "berkas" : "tautan",
        judul: String(l.judul || "").slice(0, 200),
        url: String(l.url || "").slice(0, 2000),
        mime: String(l.mime || "").slice(0, 100),
        ukuran: Number(l.ukuran) || 0,
        bagian: String(l.bagian || "").slice(0, 200)
      };
    }) : [],
    isi: String(e.isi || ""),
    tab: e.tab === true,
    soal: soal,
    // Status dan penulis ditentukan server, bukan klien. Tanpa ini seorang
    // kontributor bisa mengaku menulis atas nama orang lain, sekaligus
    // menyembunyikan kirimannya sendiri dari daftarnya.
    status: akun.peran === "pemilik" ? (e.status === "menunggu" ? "menunggu" : "terbit") : "menunggu",
    penulis: akun.peran === "pemilik" ? (e.penulis || akun.pengguna) : akun.pengguna,
    catatanTinjau: String(e.catatanTinjau || "")
  };
}

/* --------------------------------------------------------------- Handler */

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ galat: "Metode tidak didukung." });
  }
  if (!URL_KV || !TOKEN_KV) {
    return res.status(200).json({ mati: true, catatan: "Penyimpanan belum disetel." });
  }

  var b = req.body || {};
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  var aksi = String(b.aksi || "");

  try {
    await siapkanPemilik();

    /* ---- masuk ---- */
    if (aksi === "masuk") {
      var pengguna = normalPengguna(b.pengguna);
      var a = await bacaAkun(pengguna);
      // Tetap hitung hash walau akun tidak ada, supaya lamanya jawaban
      // tidak membocorkan nama pengguna mana yang terdaftar.
      var garam = (a && a.garam) || acakHex(16);
      var coba = olahSandi(String(b.sandi || ""), garam);
      if (!a || !samaAman(coba, a.hash)) {
        return res.status(401).json({ galat: "Nama pengguna atau sandi salah." });
      }
      if (a.aktif === false) return res.status(403).json({ galat: "Akun ini dinonaktifkan." });
      if (a.exp && a.exp < new Date().toISOString().slice(0, 10)) {
        return res.status(403).json({ galat: "Akun ini sudah lewat masa berlaku." });
      }
      var token = await buatSesi(a.pengguna, jejakPermintaan(req));
      var arsip = await bacaArsip();
      return res.status(200).json({
        token: token, akun: akunAman(a),
        arsip: saringUntuk(arsip, a),
        pribadi: await ambil("pribadi:" + a.pengguna, null)
      });
    }

    /* ---- masuk lewat Google / SSO kampus ---- */
    if (aksi === "masukGoogle") {
      var pg = await periksaGoogle(b.kredensial);
      if (pg.galat) return res.status(401).json({ galat: pg.galat });
      return masukLuar(pg, "google", req, res);
    }

    if (aksi === "masukSso") {
      var layananSso = String(b.layanan || "").slice(0, 300);
      if (!/^https?:\/\//.test(layananSso)) {
        return res.status(400).json({ galat: "Alamat layanan tidak sah." });
      }
      var ps = await periksaCas(b.tiket, layananSso);
      if (ps.galat) return res.status(401).json({ galat: ps.galat });
      return masukLuar(ps, "sso", req, res);
    }

    /* ---- lupa sandi ----
       Tanpa layanan email, pemulihan dijembatani pemilik: pemakai mengajukan,
       pemilik membuat kode sekali pakai, lalu menyampaikannya lewat jalur
       yang sudah mereka pakai sehari-hari. */
    if (aksi === "resetMinta") {
      var pm = normalPengguna(b.pengguna);
      var adaAkunReset = pm ? await bacaAkun(pm) : null;
      // Jawaban selalu sama, ada atau tidak akunnya, supaya tidak jadi cara
      // menebak nama pengguna siapa saja yang terdaftar.
      if (adaAkunReset) {
        var antre = await ambil("reset:antre", []);
        if (!Array.isArray(antre)) antre = [];
        if (antre.filter(function (x) { return x.pengguna === pm; }).length === 0) {
          antre.push({ pengguna: pm, pada: new Date().toISOString() });
          await simpan("reset:antre", antre.slice(-200));
        }
      }
      return res.status(200).json({
        status: "diterima",
        pesan: "Permintaan dicatat. Hubungi pemilik arsip untuk menerima kode pemulihan."
      });
    }

    if (aksi === "resetPakai") {
      var kode = String(b.kode || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
      var sandiBaru = String(b.sandi || "");
      if (!kode) return res.status(400).json({ galat: "Kodenya belum diisi." });
      if (sandiBaru.length < 8) return res.status(400).json({ galat: "Sandi baru minimal 8 karakter." });

      var milik = await redis(["GET", "reset:kode:" + kode]);
      if (!milik) return res.status(400).json({ galat: "Kode tidak berlaku atau sudah kedaluwarsa." });
      var akunReset = await bacaAkun(milik);
      if (!akunReset) return res.status(400).json({ galat: "Akunnya sudah tidak ada." });

      akunReset.garam = acakHex(16);
      akunReset.hash = olahSandi(sandiBaru, akunReset.garam);
      await tulisAkun(akunReset);
      // Kode sekali pakai, dan antreannya dibersihkan sekalian.
      await redis(["DEL", "reset:kode:" + kode]);
      var sisaAntre = (await ambil("reset:antre", [])).filter(function (x) { return x.pengguna !== milik; });
      await simpan("reset:antre", sisaAntre);

      var tokenReset = await buatSesi(milik, jejakPermintaan(req));
      return res.status(200).json({
        token: tokenReset, akun: akunAman(akunReset),
        arsip: saringUntuk(await bacaArsip(), akunReset),
        pribadi: await ambil("pribadi:" + milik, null)
      });
    }

    /* ---- daftar sendiri ----
       Sengaja tanpa token: ini justru jalannya orang yang belum punya akun.
       Akun hasil pendaftaran SELALU pengakses bertingkat publik, apa pun
       yang dikirim klien. Menaikkan aksesnya urusan pemilik lewat menu
       Akun, dan itu yang jadi gerbang setelah orangnya membayar. */
    if (aksi === "daftar") {
      var bukaDaftar = await ambil("atur:pendaftaran", false);
      if (bukaDaftar !== true) {
        return res.status(403).json({ galat: "Pendaftaran sedang ditutup. Minta akun ke pemilik arsip." });
      }
      var pd = normalPengguna(b.pengguna);
      if (pd.length < 3) {
        return res.status(400).json({ galat: "Nama pengguna minimal 3 karakter, hanya huruf, angka, titik, dan strip." });
      }
      var sandiD = String(b.sandi || "");
      if (sandiD.length < 8) {
        return res.status(400).json({ galat: "Sandi minimal 8 karakter." });
      }
      if (await bacaAkun(pd)) {
        return res.status(409).json({ galat: "Nama pengguna itu sudah dipakai. Coba yang lain." });
      }
      var daftarNama = await daftarPengguna();
      if (daftarNama.length >= 500) {
        return res.status(429).json({ galat: "Kuota akun sudah penuh. Hubungi pemilik arsip." });
      }

      var garamD = acakHex(16);
      var akunBaru = {
        pengguna: pd,
        nama: String(b.nama || pd).slice(0, 120),
        garam: garamD,
        hash: olahSandi(sandiD, garamD),
        peran: "pengakses",
        tingkat: "publik",
        exp: "",
        aktif: true,
        ai: false,
        mandiri: true,
        dibuat: new Date().toISOString().slice(0, 10)
      };
      await tulisAkun(akunBaru);
      var tokenD = await buatSesi(pd, jejakPermintaan(req));
      return res.status(200).json({
        token: tokenD, akun: akunAman(akunBaru),
        arsip: saringUntuk(await bacaArsip(), akunBaru),
        pribadi: null
      });
    }

    /* ---- semua aksi di bawah butuh token ---- */
    var akun = await akunDariToken(b.token);
    if (akun && akun.tergusur) {
      return res.status(401).json({
        tergusur: true,
        galat: "Akun ini baru saja dipakai masuk di perangkat lain, jadi sesi di sini ditutup. " +
          "Satu akun hanya bisa aktif di satu perangkat."
      });
    }

    /* ---- muat (tanpa token = tamu, hanya materi publik) ---- */
    if (aksi === "muat") {
      var arsipSemua = await bacaArsip();
      return res.status(200).json({
        akun: akun ? akunAman(akun) : null,
        arsip: saringUntuk(arsipSemua, akun),
        pribadi: akun ? await ambil("pribadi:" + akun.pengguna, null) : null,
        tugasan: tugasanUntuk(await bacaTugasan(), akun),
        pendaftaran: (await ambil("atur:pendaftaran", false)) === true,
        masukLuar: { google: !!GOOGLE_CLIENT_ID, googleId: GOOGLE_CLIENT_ID,
                     sso: !!SSO_CAS, ssoNama: SSO_NAMA,
                     ssoAlamat: SSO_CAS ? SSO_CAS + "/login" : "" },
        adaAkun: (await daftarPengguna()).length > 0
      });
    }

    if (!akun) return res.status(401).json({ galat: "Sesi tidak berlaku, masuk lagi." });

    /* ---- keluar ---- */
    if (aksi === "keluar") {
      await redis(["DEL", "sesi:" + String(b.token || "")]);
      await redis(["DEL", "sesiAktif:" + akun.pengguna]);
      return res.status(200).json({ status: "keluar" });
    }

    /* ---- data pribadi (tracker IPK, skor kuis, latar) ---- */
    if (aksi === "pribadiSimpan") {
      await simpan("pribadi:" + akun.pengguna, b.pribadi || {});
      return res.status(200).json({ status: "tersimpan" });
    }

    /* ---- ganti sandi sendiri ---- */
    if (aksi === "gantiSandi") {
      var lamaOk = samaAman(olahSandi(String(b.lama || ""), akun.garam), akun.hash);
      if (!lamaOk) return res.status(403).json({ galat: "Sandi lama tidak cocok." });
      if (String(b.baru || "").length < 6) return res.status(400).json({ galat: "Sandi baru minimal 6 karakter." });
      akun.garam = acakHex(16);
      akun.hash = olahSandi(String(b.baru), akun.garam);
      await tulisAkun(akun);
      return res.status(200).json({ status: "diganti" });
    }

    /* ---- simpan entri (pemilik & kontributor) ---- */
    if (aksi === "entriSimpan") {
      if (akun.peran !== "pemilik" && akun.peran !== "kontributor") {
        return res.status(403).json({ galat: "Akun ini hanya boleh membaca." });
      }
      var arsipA = await bacaArsip();
      var masuk = Array.isArray(b.entri) ? b.entri : [b.entri];
      var daftarEntri = arsipA.entri.slice();
      var jumlahBaru = 0, jumlahUbah = 0;

      masuk.forEach(function (mentah) {
        if (!mentah || !mentah.judul) return;
        var e = bersihEntri(mentah, akun);
        var idx = -1;
        for (var i = 0; i < daftarEntri.length; i++) {
          if (daftarEntri[i].id === e.id) { idx = i; break; }
        }
        if (idx >= 0) {
          // Kontributor hanya boleh menyunting tulisannya sendiri.
          if (akun.peran !== "pemilik" && daftarEntri[idx].penulis !== akun.pengguna) return;
          e.penulis = daftarEntri[idx].penulis;
          daftarEntri[idx] = e;
          jumlahUbah++;
        } else {
          daftarEntri.push(e);
          jumlahBaru++;
        }
      });

      await simpan("arsip:entri", daftarEntri);
      await simpan("arsip:versi", (arsipA.versi || 0) + 1);
      return res.status(200).json({
        status: "tersimpan", baru: jumlahBaru, diubah: jumlahUbah,
        arsip: saringUntuk(await bacaArsip(), akun)
      });
    }

    /* ---- hapus entri (pemilik) ---- */
    if (aksi === "entriHapus") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik yang boleh menghapus." });
      var arsipH = await bacaArsip();
      var sisa = arsipH.entri.filter(function (e) { return e.id !== b.id; });
      await simpan("arsip:entri", sisa);
      await simpan("arsip:versi", (arsipH.versi || 0) + 1);
      return res.status(200).json({ status: "dihapus", arsip: saringUntuk(await bacaArsip(), akun) });
    }

    /* ---- tinjau kiriman kontributor (pemilik) ---- */
    if (aksi === "entriTinjau") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik yang boleh meninjau." });
      var arsipT = await bacaArsip();
      arsipT.entri.forEach(function (e) {
        if (e.id !== b.id) return;
        if (b.terima) { e.status = "terbit"; e.catatanTinjau = ""; }
        else { e.status = "dikembalikan"; e.catatanTinjau = String(b.catatan || ""); }
      });
      await simpan("arsip:entri", arsipT.entri);
      await simpan("arsip:versi", (arsipT.versi || 0) + 1);
      return res.status(200).json({ status: "ditinjau", arsip: saringUntuk(await bacaArsip(), akun) });
    }

    /* ---- pengaturan situs (pemilik) ---- */
    if (aksi === "aturSimpan") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      if (b.teks) await simpan("arsip:teks", b.teks);
      if (b.tema) await simpan("arsip:tema", b.tema);
      if (b.stase) await simpan("arsip:stase", b.stase);
      if (b.staseUbah) await simpan("arsip:staseUbah", b.staseUbah);
      if (b.staseGambar) await simpan("arsip:staseGambar", b.staseGambar);
      if (typeof b.ikon === "string") await simpan("arsip:ikon", b.ikon);
      if (Array.isArray(b.berkas)) await simpan("arsip:berkas", b.berkas.slice(0, 1000));
      if (typeof b.pendaftaran === "boolean") await simpan("atur:pendaftaran", b.pendaftaran);
      // Agenda bersama diumumkan pemilik dan terlihat semua peran, jadi
      // ikut arsip, bukan ember pribadi tiap akun.
      if (Array.isArray(b.agenda)) await simpan("arsip:agenda", b.agenda.slice(0, 500));
      return res.status(200).json({ status: "tersimpan", arsip: saringUntuk(await bacaArsip(), akun) });
    }

    /* ---- pengingat yang ditugaskan ke akun lain ----
       Terbuka untuk semua peran: menjadwalkan jaga bersama teman bukan
       tindakan menulis arsip, jadi pengakses pun boleh. */
    if (aksi === "akunRingkas") {
      var namaR = await daftarPengguna();
      var ringkas = [];
      for (var ri = 0; ri < namaR.length; ri++) {
        var ar = await bacaAkun(namaR[ri]);
        // Hanya nama panggilan dan nama pengguna. Peran, tingkat akses,
        // dan masa berlaku bukan urusan sesama pemakai.
        if (ar && ar.aktif !== false) {
          // Grup ikut dibuka karena berguna saat menugaskan jadwal; sisa
          // profil (NIM, telepon, universitas) tetap tidak dibagikan.
          ringkas.push({ pengguna: ar.pengguna, nama: ar.nama || ar.pengguna, grup: ar.grup || "" });
        }
      }
      return res.status(200).json({ akun: ringkas });
    }

    if (aksi === "agendaTugas") {
      var masukT = b.agenda || {};
      if (!String(masukT.judul || "").trim()) {
        return res.status(400).json({ galat: "Nama kegiatan belum diisi." });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(masukT.tanggal || ""))) {
        return res.status(400).json({ galat: "Tanggalnya tidak sah." });
      }

      // Hanya akun yang benar-benar ada yang boleh jadi sasaran.
      var semuaNama = await daftarPengguna();
      var mintaUntuk = Array.isArray(masukT.untuk) ? masukT.untuk.slice(0, 30) : [];
      var untukSah = [];
      mintaUntuk.forEach(function (u) {
        var uu = String(u || "").toLowerCase();
        if (semuaNama.indexOf(uu) !== -1 && untukSah.indexOf(uu) === -1) untukSah.push(uu);
      });

      var daftarT = await bacaTugasan();
      var baruT = bersihTugasan(masukT, akun, untukSah);
      var idxT = -1;
      for (var ti = 0; ti < daftarT.length; ti++) {
        if (daftarT[ti].id === baruT.id) { idxT = ti; break; }
      }
      if (idxT >= 0) {
        if (daftarT[idxT].pembuat !== akun.pengguna) {
          return res.status(403).json({ galat: "Cuma pembuatnya yang bisa mengubah pengingat ini." });
        }
        daftarT[idxT] = baruT;
      } else {
        if (daftarT.length >= 2000) {
          return res.status(400).json({ galat: "Daftar pengingat bersama sudah penuh." });
        }
        daftarT.push(baruT);
      }
      await simpan("agenda:tugasan", daftarT);
      return res.status(200).json({ status: "tersimpan", tugasan: tugasanUntuk(daftarT, akun) });
    }

    if (aksi === "agendaTugasHapus") {
      var idH = String(b.id || "").slice(0, 64);
      var daftarH = await bacaTugasan();
      var sasaranH = daftarH.filter(function (x) { return x.id === idH; })[0];
      if (!sasaranH) return res.status(404).json({ galat: "Pengingat tidak ditemukan." });
      if (sasaranH.pembuat !== akun.pengguna && akun.peran !== "pemilik") {
        return res.status(403).json({ galat: "Cuma pembuatnya yang bisa menghapus pengingat ini." });
      }
      var sisaH = daftarH.filter(function (x) { return x.id !== idH; });
      await simpan("agenda:tugasan", sisaH);
      return res.status(200).json({ status: "dihapus", tugasan: tugasanUntuk(sisaH, akun) });
    }

    /* ---- profil akun sendiri ---- */
    if (aksi === "profilSimpan") {
      var pr = akun;
      pr.nama = String(b.nama || pr.nama || pr.pengguna).slice(0, 120);
      pr.universitas = String(b.universitas || "").slice(0, 160);
      pr.angkatan = String(b.angkatan || "").slice(0, 20);
      pr.grup = String(b.grup || "").slice(0, 80);
      pr.nim = String(b.nim || "").slice(0, 40);
      pr.staseKini = String(b.staseKini || "").slice(0, 80);
      pr.rsKini = String(b.rsKini || "").slice(0, 120);
      pr.telepon = String(b.telepon || "").slice(0, 40);
      pr.bio = String(b.bio || "").slice(0, 400);
      await tulisAkun(pr);
      return res.status(200).json({ status: "tersimpan", akun: akunAman(pr) });
    }

    /* ---- pemulihan sandi: sisi pemilik ---- */
    if (aksi === "resetAntre") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      return res.status(200).json({ antre: await ambil("reset:antre", []) });
    }

    if (aksi === "resetBuat") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      var sasaran = normalPengguna(b.pengguna);
      if (!(await bacaAkun(sasaran))) return res.status(404).json({ galat: "Akun tidak ditemukan." });
      // Tanpa huruf/angka yang mudah tertukar saat dibacakan (0/O, 1/I).
      var abjad = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      var kodeBaru = "";
      var acak = crypto.randomBytes(8);
      for (var ki = 0; ki < 8; ki++) kodeBaru += abjad[acak[ki] % abjad.length];
      await redis(["SET", "reset:kode:" + kodeBaru, sasaran, "EX", "86400"]);
      return res.status(200).json({ kode: kodeBaru, pengguna: sasaran, berlaku: "24 jam" });
    }

    if (aksi === "resetBatal") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      var buang = normalPengguna(b.pengguna);
      var sisa = (await ambil("reset:antre", [])).filter(function (x) { return x.pengguna !== buang; });
      await simpan("reset:antre", sisa);
      return res.status(200).json({ antre: sisa });
    }

    /* ---- lampiran berkas ----
       Isi berkas disimpan di kunci sendiri, bukan di dalam arsip:entri.
       Kalau digabung, tiap pemuatan halaman ikut menyeret semua PDF dan
       gambar sekaligus, dan arsipnya jadi berat untuk semua orang. */
    if (aksi === "lampiranSimpan") {
      if (akun.peran !== "pemilik" && akun.peran !== "kontributor") {
        return res.status(403).json({ galat: "Akun ini hanya boleh membaca." });
      }
      var dataL = typeof b.data === "string" ? b.data : "";
      if (!dataL || !/^[A-Za-z0-9+/=]+$/.test(dataL)) {
        return res.status(400).json({ galat: "Lampiran bukan base64 yang sah." });
      }
      if (dataL.length > 4300000) {
        return res.status(400).json({ galat: "Berkasnya melebihi batas permintaan Vercel. Pakai tautan untuk berkas besar." });
      }
      var idL = String(b.id || "").slice(0, 64);
      if (!/^[A-Za-z0-9_-]+$/.test(idL)) {
        return res.status(400).json({ galat: "Nama lampiran tidak sah." });
      }
      await simpan("lampiran:" + idL, {
        entriId: String(b.entriId || "").slice(0, 64),
        nama: String(b.nama || "berkas").slice(0, 200),
        mime: String(b.mime || "application/octet-stream").slice(0, 100),
        data: dataL
      });
      return res.status(200).json({ status: "tersimpan", id: idL });
    }

    if (aksi === "lampiranAmbil") {
      var idA = String(b.id || "").slice(0, 64);
      if (!/^[A-Za-z0-9_-]+$/.test(idA)) {
        return res.status(400).json({ galat: "Nama lampiran tidak sah." });
      }
      var lampA = await ambil("lampiran:" + idA, null);
      if (!lampA) return res.status(404).json({ galat: "Lampiran tidak ditemukan." });
      // Lampiran mewarisi izin entri induknya. Tanpa cek ini, tautan
      // langsung ke lampiran jadi jalan pintas ke materi berbayar.
      var arsipL = await bacaArsip();
      var induk = (arsipL.entri || []).filter(function (x) { return x.id === lampA.entriId; })[0];
      if (!bolehLihat(induk, akun)) {
        return res.status(403).json({ galat: "Lampiran ini tidak terbuka untuk akunmu." });
      }
      return res.status(200).json({ nama: lampA.nama, mime: lampA.mime, data: lampA.data });
    }

    /* ---- jejak masuk (pemilik) ----
       Bukan untuk mengintai, tapi supaya pola berbagi akun kelihatan:
       satu akun yang masuk dari banyak kota dalam sehari sulit dijelaskan
       selain karena dipakai ramai-ramai. */
    if (aksi === "riwayatAkun") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      var sasaranR = normalPengguna(b.pengguna);
      if (!sasaranR) return res.status(400).json({ galat: "Sebutkan akunnya." });
      return res.status(200).json({
        pengguna: sasaranR,
        terakhir: await ambil("perangkat:" + sasaranR, null),
        riwayat: await ambil("riwayat:" + sasaranR, [])
      });
    }

    if (aksi === "putusSesi") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      var sasaranP = normalPengguna(b.pengguna);
      var tokenLama = await redis(["GET", "sesiAktif:" + sasaranP]);
      if (tokenLama) await redis(["DEL", "sesi:" + tokenLama]);
      await redis(["DEL", "sesiAktif:" + sasaranP]);
      return res.status(200).json({ status: "diputus", pengguna: sasaranP });
    }

    /* ---- kelola akun (pemilik) ---- */
    if (aksi === "akunDaftar") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      var nama = await daftarPengguna();
      var semua = [];
      for (var i = 0; i < nama.length; i++) {
        var x = await bacaAkun(nama[i]);
        if (x) semua.push(akunAman(x));
      }
      return res.status(200).json({ akun: semua });
    }

    if (aksi === "akunSimpan") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      var p = normalPengguna(b.pengguna);
      if (p.length < 3) return res.status(400).json({ galat: "Nama pengguna minimal 3 karakter." });

      var lama = await bacaAkun(p);
      var baru = lama || {
        pengguna: p, garam: acakHex(16), hash: "",
        dibuat: new Date().toISOString().slice(0, 10)
      };
      baru.nama = String(b.nama || p).slice(0, 120);
      baru.peran = ["pemilik", "kontributor", "pengakses"].indexOf(b.peran) !== -1 ? b.peran : "pengakses";
      baru.tingkat = b.tingkat === "publik" ? "publik" : "penuh";
      baru.exp = String(b.exp || "");
      baru.aktif = b.aktif !== false;
      baru.ai = b.ai === true;
      // Menautkan surel membuat akun ini bisa dimasuki lewat Google/SSO.
      if (typeof b.surel === "string") {
        var surelBaru = b.surel.trim().toLowerCase().slice(0, 200);
        if (baru.surel && baru.surel !== surelBaru) await redis(["DEL", "surel:" + baru.surel]);
        baru.surel = surelBaru;
        if (surelBaru) await simpan("surel:" + surelBaru, p);
      }

      if (b.sandi) {
        if (String(b.sandi).length < 6) return res.status(400).json({ galat: "Sandi minimal 6 karakter." });
        baru.garam = acakHex(16);
        baru.hash = olahSandi(String(b.sandi), baru.garam);
      }
      if (!baru.hash) return res.status(400).json({ galat: "Akun baru wajib diberi sandi." });

      // Jangan sampai pemilik terakhir menurunkan dirinya sendiri dan
      // situsnya jadi tidak bisa dikelola siapa pun.
      if (lama && lama.peran === "pemilik" && baru.peran !== "pemilik") {
        var daftarP = await daftarPengguna();
        var jumlahPemilik = 0;
        for (var k = 0; k < daftarP.length; k++) {
          var cek = await bacaAkun(daftarP[k]);
          if (cek && cek.peran === "pemilik" && cek.aktif !== false) jumlahPemilik++;
        }
        if (jumlahPemilik <= 1) {
          return res.status(400).json({ galat: "Ini satu-satunya akun pemilik yang aktif." });
        }
      }

      await tulisAkun(baru);
      return res.status(200).json({ status: "tersimpan", akun: akunAman(baru) });
    }

    if (aksi === "akunHapus") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      var target = normalPengguna(b.pengguna);
      if (target === akun.pengguna) return res.status(400).json({ galat: "Tidak bisa menghapus akunmu sendiri." });
      await redis(["DEL", "akun:" + target]);
      await redis(["DEL", "pribadi:" + target]);
      var sisaAkun = (await daftarPengguna()).filter(function (n) { return n !== target; });
      await simpan("akun:daftar", sisaAkun);
      return res.status(200).json({ status: "dihapus" });
    }

    return res.status(400).json({ galat: "Aksi tidak dikenal." });

  } catch (err) {
    return res.status(500).json({ galat: String((err && err.message) || err) });
  }
};
