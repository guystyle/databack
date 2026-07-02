# EXIF Databack — 프로젝트 인수인계 (Claude Code 세션용)

이 문서는 Claude 챗 세션에서 여기까지 만든 맥락을 Claude Code로 이어가기 위한 인수인계 노트다.
GUYSTYLE이 인스타 스토리에 올릴 사진에 **필름카메라 데이터백 스타일 날짜 각인**을 넣는 웹앱.

---

## 무엇을 만드는가

사진을 올리면 EXIF에서 촬영 정보를 뽑아, 사진 위에 프레임/데이터백 각인을 얹어 저장하는 웹앱.
핵심 용도는 **인스타 스토리에 올릴 사진의 데이터백 각인**. (별도 AR 필터가 아님 — Meta Spark는 2025년 종료됨)

배포 대상: **Vercel** (실제 모바일 브라우저에서 저장/회전 검증이 필요하기 때문. 클로드 아티팩트 iframe 샌드박스에서는 파일 저장이 제대로 안 됨.)

---

## 시장 판단 (이미 검토 완료)

- EXIF 프레임/워터마크 앱은 이미 포화 시장 (PhotoFramify, OneLine, MarkFrame 등 다수).
- 데이터백/데이트스탬프도 포화 (Filmlike Date Stamp 10종, Timestamp Camera 26종+).
- 결론: **대중 서비스보다는 GUYSTYLE 본인 스토리 워크플로우용 개인 도구**로 포지셔닝하는 게 현실적.
- 수요 자체는 TikTok 튜토리얼 등에서 꾸준히 확인됨.

---

## 현재 구조

```
exif-databack/
├── index.html            # 엔트리 (viewport-fit=cover, 다크 배경)
├── src/
│   ├── main.jsx          # React 마운트
│   └── ExifFrameApp.jsx  # 전체 앱 (단일 컴포넌트, 외부 EXIF 라이브러리 없음)
├── package.json          # vite + react + lucide-react
├── vite.config.js
├── vercel.json           # SPA rewrite
└── CLAUDE.md             # 이 문서
```

로컬 실행: `npm install && npm run dev`
빌드: `npm run build` (검증 완료, 통과함)
배포: `vercel` (또는 GitHub 연동 후 자동 배포)

---

## 핵심 기능과 구현 세부

### EXIF 파서 (`parseExif`)
- 외부 라이브러리 없이 JPEG APP1 세그먼트를 직접 파싱.
- Make, Model, Orientation, LensModel, ExposureTime, FNumber, ISO, FocalLength, DateTimeOriginal 추출.
- GPS는 프라이버시상 의도적으로 안 뽑음.
- **검증됨**: Canon PowerShot V1 원본에서 Python PIL과 동일한 값 확인.
  - 예: Make=Canon, Model=Canon PowerShot V1, 1/1600s, f/5, ISO100, 12mm, 2026:06:27.
  - LensModel은 렌즈 일체형이라 원래 비어있음 (파서 문제 아님).

### 프레임 스타일 3종 (`STYLES`)
- **film**: 어두운 프레임 + 하단 텍스트 (하단 잘림 버그 수정 완료, Make/Model 중복 제거 완료)
- **polaroid**: 크림색 하단 여백
- **databack**: 사진에 직접 각인 (아래 상세)

### 데이터백 각인 (확정된 튜닝값 — 절대 임의로 바꾸지 말 것)
GUYSTYLE이 레퍼런스 사진(밤 장면, 주황 7세그 각인) 기준으로 반복 조정해 확정한 값:

- **날짜 포맷**: `'26 06 27` (앞 아포스트로피 + 2자리 연도, 공백 구분) — `fmtDatabackDate()`
- **글리프**: 7-세그먼트를 canvas path로 직접 그림 (`SEG`, `drawSegDigit`, `drawSegApos`)
- **이탤릭**: `DB_SLANT = 0.09` (베이스라인 기준 shear. 값 작을수록 더 수직. 0.16→0.09로 세운 게 최종)
- **색**: 글로우 `rgba(255,74,18,*)`, 코어 `rgba(255,120,50,0.95)` (진한 오렌지-레드. 노란기 뺌)
- **크기**: `dh = drawW * 0.024` (작게)
- **위치**: 우측 하단, `pad = drawW * 0.085` 만큼 안쪽으로 인셋
- **자간**: `segMeasure`에서 sep=dh*0.26, 그룹공백 grp=dh*0.75 (넓게)
- **발광 방식**: 그림자 아님. `globalCompositeOperation = "lighter"` (가산 합성)로
  3개 레이어(넓은 헤일로 / 좁은 헤일로 / 뜨거운 코어)를 겹침 → 필름에 빛이 태워진 느낌.
  - **주의**: 어두운 배경에서 극적으로 살고, 밝은 배경(낮 사진)에선 약해짐. 이건 실제 데이터백과
    동일한 물리적 특성이라 의도된 동작. 밝은 배경 대응이 필요하면 코어 불투명도를 올리는 절충 필요.

원래 Python(Pillow)으로 프로토타이핑한 뒤 canvas로 포팅한 것.
Pillow는 screen 블렌드, canvas는 lighter(가산) 합성 — 원리는 비슷하나 미세한 밝기차 가능.
실제 브라우저에서 글로우가 너무 세거나 약하면 레이어 alpha값(0.45/0.75/0.95) 조정.

---

## 미해결 이슈 (Claude Code에서 최우선으로 볼 것)

### 1. [열림] 세로 사진이 가로로 눕는 문제 ⚠️ 최우선
- 세로로 찍은 사진이 UI에서 가로로 눕혀져 보임.
- **원인 미확정**. 추정 후보:
  - (a) 자동 축소 시 정규화 JPEG를 다시 만들 때 EXIF Orientation 태그가 유실되는데
        (canvas.toDataURL은 EXIF를 안 붙임), draw()는 원본에서 읽은 orientation을 여전히 적용 → 정합성 문제.
  - (b) `createImageBitmap(file, {imageOrientation:"none"})`로 회전 안 하게 했는데,
        카메라가 픽셀을 이미 세로로 저장 + Orientation 태그도 세팅한 경우 이중 회전/역회전 가능.
  - (c) Canon은 기종에 따라 "가로픽셀+회전태그" vs "세로픽셀+정상태그"가 섞임.
- **반드시 실제로 눕는 세로 사진 1장을 받아서** 픽셀 방향 + Orientation 태그값을 확인한 뒤 고칠 것.
  추측으로 고치면 멀쩡한 가로 사진까지 돌아감.
- 관련 코드: `handleFile`의 축소/정규화 로직, `draw()`의 orientation 회전 (rotate 6/8/3 분기).

### 2. [부분수정] 모바일 저장 버튼
- 원래 `<a download>`가 iOS Safari에서 무시돼서 안 눌렸음.
- 현재: 모바일이면 결과를 전체화면 오버레이로 띄워 롱프레스 저장 유도 (`savedUrl` state).
  데스크톱은 기존 다운로드.
- **단, 이 문제의 상당 부분은 클로드 아티팩트 iframe 샌드박스 제약이었을 가능성이 큼.**
  Vercel 실배포 후 실제 모바일 브라우저에서 다시 검증할 것. 어쩌면 평범한 `<a download>`로도
  충분할 수 있음. 실환경 확인 후 오버레이 방식이 불필요하면 단순화 고려.

### 3. [알려진 제약] HEIC 미지원
- 아이폰 기본 HEIC는 브라우저가 디코드/EXIF 파싱 불가.
- heic2any(cdnjs 0.0.1)가 있지만 **변환 시 EXIF를 버림** → 촬영 날짜가 사라져 데이터백에 쓸 수 없음.
- 그래서 자동 변환 안 넣음. 대신 HEIC 감지 시 "설정에서 JPEG로 바꾸라"는 안내 메시지.
- Canon PowerShot V1은 원래 JPEG(정확히는 MPO)라 문제없음.

### 4. [처리됨] MPO / 대용량
- PowerShot V1의 .jpeg는 실제로는 MPO(멀티이미지) 포맷 + 22MP(5760×3840).
- MPO는 `<img>`가 디코드 실패할 수 있고, 22MP는 iOS canvas 한도(~16.7MP) 초과.
- 현재: `createImageBitmap`으로 디코드 → 한 변 max 3600px로 자동 축소 → 8.6MP로 정규화.
- EXIF는 항상 원본 바이트에서 먼저 파싱하므로 축소해도 날짜 보존됨.
- 이 로직이 이슈 #1(회전)과 얽혀 있으니 함께 볼 것.

---

## 다음 할 일 제안 순서

1. GitHub 레포 만들고 Vercel 연결 → 실배포 URL 확보.
2. 실제 모바일 브라우저에서 세로 사진 업로드 → 이슈 #1 재현 및 픽셀/태그 진단 → 수정.
3. 실배포에서 저장 버튼 검증 → 필요시 이슈 #2 단순화.
4. 데이터백 글로우 세기 실환경 미세조정.
5. (선택) databack 스타일일 때 하단 필드토글/캡션 UI 숨기기 — 현재 databack엔 안 쓰임.

## 하지 말 것
- 확정된 데이터백 튜닝값(SLANT 0.09, 색, 크기 0.024, pad 0.085, 자간)을 임의로 바꾸지 말 것.
- 회전 로직을 실제 사진 확인 없이 추측으로 수정하지 말 것.
- HEIC 자동 변환 넣지 말 것 (EXIF 유실됨).
