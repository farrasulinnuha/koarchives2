# Arsip Koas — cara pasang di Vercel

Isi folder `dist/` sudah siap pakai. Situsnya statis: satu berkas HTML plus ikon,
tanpa server, tanpa basis data, tanpa proses build di sisi Vercel.

```
dist/
  index.html                 <- aplikasinya, semua di sini (~245 KB)
  vercel.json                <- pengaturan cache dan header
  manifest.webmanifest       <- supaya bisa dipasang di layar utama HP
  icon-192.png
  icon-512.png
  icon-512-maskable.png
  apple-touch-icon.png
  robots.txt
```

## Cara 1 — Seret foldernya (paling cepat, tanpa terminal)

1. Buka [vercel.com/new](https://vercel.com/new), masuk pakai akun Google/GitHub.
2. Seret folder **`dist`** ke halaman itu.
3. Tunggu beberapa detik. Kamu dapat alamat seperti `arsip-koas.vercel.app`.

## Cara 2 — Lewat terminal

Dari dalam folder `dist`:

```bash
npx vercel --prod
```

Ikuti pertanyaannya (login, nama proyek, folder root biarkan `./`).

## Cara 3 — Lewat GitHub (paling enak untuk pembaruan rutin)

Folder ini sudah siap jadi repo: ada `.gitignore` dan `package.json`.
Dari dalam folder `dist`:

```bash
git init -b main
git add .
git commit -m "Arsip Koas"
```

Buat repo kosong di GitHub (**jangan** centang "Add a README"), lalu:

```bash
git remote add origin https://github.com/NAMAMU/arsip-koas.git
git push -u origin main
```

Di Vercel: **Add New → Project → Import** repo tadi. Framework Preset
**Other**, Build Command dan Output Directory dikosongkan — situs ini
tidak punya langkah build.

Setelah itu tiap `git push` otomatis mendeploy ulang:

```bash
git add . && git commit -m "perbarui materi" && git push
```

`package.json` di sini tidak menarik dependensi apa pun. Isinya cuma
menandai `node >=18` supaya fungsi di `api/` dapat `fetch` bawaan.

## Pasang di layar utama HP

Buka alamat hasil deploy di HP:

- **iPhone (Safari)** — tombol Bagikan → *Add to Home Screen*
- **Android (Chrome)** — menu titik tiga → *Tambahkan ke layar utama*

Ikonnya muncul seperti aplikasi biasa dan terbuka layar penuh.

## Domain sendiri

Di dasbor proyek Vercel → **Settings → Domains** → tambahkan domainmu, lalu
ikuti petunjuk DNS-nya. Kalau mau alamat pendek saja, deploy dulu ke Vercel,
baru pendekkan alamatnya di s.id atau bit.ly — keduanya pemendek tautan,
bukan hosting, jadi tidak bisa menampung berkasnya sendiri.

---

## Memperbarui isinya

Sumbernya ada di `../index.html`. Setelah diubah, bangun ulang:

```bash
python3 build-vercel.py
```

Lalu deploy ulang folder `dist` dengan salah satu cara di atas.

`index.html` di folder induk sengaja **tidak** punya `<!doctype html>` dan `<head>`,
karena versi itu dipakai untuk Artifact Claude yang membungkusnya sendiri.
Skrip build yang menambahkan pembungkusnya untuk hosting biasa. Jangan menyalin
`../index.html` langsung ke Vercel — tanpa doctype, browser masuk quirks mode.

## Menyalakan server (WAJIB — ini yang bikin datanya nyata)

Tanpa langkah ini situs hanya menyimpan di browser: beda laptop = kosong, dan
"kunci" cuma menyembunyikan tombol. Dengan langkah ini akun dan isi arsip
hidup di server.

### 1. Buat penyimpanan

Dasbor proyek Vercel -> **Storage** -> **Create Database** -> **Upstash for
Redis** (ada paket gratis). Vercel otomatis menambahkan `KV_REST_API_URL` dan
`KV_REST_API_TOKEN`.

### 2. Buat akun pemilik pertama

**Settings -> Environment Variables**, tambahkan:

| Nama | Isi |
|---|---|
| `PEMILIK_AWAL` | `namamu:sandimu` (mis. `ulin:sandiRahasia123`) |

Deploy ulang, lalu buka situsnya dan masuk dengan itu. Setelah akun pemilik
terbentuk, **hapus `PEMILIK_AWAL`** dan deploy ulang sekali lagi — variabel itu
hanya dipakai kalau belum ada akun sama sekali.

### 3. Selesai

Akun berikutnya kamu buat sendiri lewat **Atur -> Akun** di dalam situs.
Tidak perlu menerbitkan ulang apa pun, dan tidak perlu lapor ke Claude.

Tiga peran:

| Peran | Bisa apa |
|---|---|
| **pemilik** | atur situs, kelola akun, terbitkan, hapus |
| **kontributor** | kirim entri; masuk antrean tinjauan pemilik |
| **pengakses** | hanya membaca |

Ditambah tingkat akses **penuh** (semua materi) atau **publik** (hanya materi
bertanda gratis).

### Memperbarui situs tanpa kehilangan data

Isi arsip ada di Redis, bukan di `index.html`. Jadi `git push` / deploy ulang
berapa kali pun **tidak menyentuh data**. Yang berubah cuma tampilan dan kode.

### Menyambungkan ke Claude (opsional)

Tambahkan `ANTHROPIC_API_KEY` di Environment Variables — ambil kuncinya di
console.anthropic.com dan tempel langsung di dasbor Vercel, jangan pernah
menaruhnya di kode atau mengirimkannya lewat chat. Lalu centang **"Boleh
memakai Claude"** pada akun yang kamu izinkan. Batas bawaan 30 permintaan per
akun per hari (`BATAS_AI_HARIAN` untuk mengubah).

## Yang perlu diingat

- Dengan server menyala, isi arsip dan data pribadi (tracker IPK, skor kuis)
  ikut akunmu ke perangkat mana pun.
- Materi bertanda **Publik** memang bisa dibaca tanpa login. Materi
  **Terbatas** tidak pernah dikirim ke browser yang belum berhak.
- Pendaftaran mandiri belum ada: akun dibuat pemilik lewat menu Atur.
- Materi bertanda **Publik** memang terkirim tanpa enkripsi supaya bisa
  dibaca tanpa akun. Jangan menaruh materi berbayar di sana.
