import { Component, signal, computed, OnInit, inject, DestroyRef, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';

// --- Interfaces ---

interface PrismaAnalysis {
  signal: 'COMPRA' | 'VENDA' | 'AGUARDAR';
  assertividade: number;
  reason: string;
  filters_status: {
    exaustao_detectada: boolean;
    descanso_identificado: boolean;
    pavios_favoraveis: boolean;
    sfp_presente: boolean;
    fluxo_confirmado: boolean;
    lateralizacao: boolean;
    suporte_resistencia: 'Em zona de suporte' | 'Em zona de resistência' | 'Neutro';
    tendencia_macro: 'A favor' | 'Contra' | 'Lateral';
  };
  next_candle_prediction: 'Alta' | 'Baixa' | 'Indefinida';
  risk_level: 'BAIXO' | 'MÉDIO' | 'ALTO';
  notes: string;
  timestamp: string;
}

interface TradeHistory {
  id: string;
  timestamp: string;
  signal: 'COMPRA' | 'VENDA';
  assertividade: number;
  result: 'WIN' | 'LOSS' | 'PENDING';
  profit: number;
}

@Component({
  selector: 'app-root',
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styles: []
})
export class AppComponent implements OnInit, AfterViewInit {
  // --- View Children for Capture ---
  @ViewChild('videoRef') videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvasRef') canvasElement!: ElementRef<HTMLCanvasElement>;
  @ViewChild('matrixCanvas') matrixCanvas!: ElementRef<HTMLCanvasElement>;

  // --- Global State ---
  currentTime = signal<string>('');
  timeframe = signal<'1M' | '5M' | '15M'>('1M');
  
  // --- Capture & Robot State ---
  stream = signal<MediaStream | null>(null);
  syncActive = signal<boolean>(false); // Robot Active state
  isAnalyzing = signal<boolean>(false);
  isPaused = signal<boolean>(false); // Stop Loss Trigger
  
  consecutiveLosses = signal<number>(0);
  countdown = signal<string>('00:00');
  
  // --- Data ---
  currentAnalysis = signal<PrismaAnalysis | null>(null);
  tradeHistory = signal<TradeHistory[]>([]);
  
  // --- Derived Stats ---
  stats = computed(() => {
    const history = this.tradeHistory();
    const completed = history.filter(t => t.result !== 'PENDING');
    const wins = completed.filter(t => t.result === 'WIN').length;
    const losses = completed.filter(t => t.result === 'LOSS').length;
    const winRate = completed.length > 0 ? ((wins / completed.length) * 100).toFixed(0) : '0';
    
    return {
      total: completed.length,
      wins,
      losses,
      winRate
    };
  });

  private destroyRef = inject(DestroyRef);
  private syncTimer: any;
  private clockTimer: any;
  private matrixInterval: any;

  // --- PRISMA BRAIN CONTEXT (The Logic passed to AI) ---
  private readonly PRISMA_CONTEXT_INSTRUCTIONS = `
Você é um robô trader humanoide especialista em opções binárias de 1 minuto (1m) na Pocket Option, focado em OTC. Você interpreta gráficos como um trader humano experiente e ultra cauteloso: "vê" nuances sutis, sente o flow, detecta psicologia e armadilhas, e gera sinais CALL/PUT só quando super assertivo e anti-manipulação. Integre o Indicador Ventilador (Gann Fan) para zonas dinâmicas.

Conhecimento completo da Pocket Option desde 2017 até 2025, incluindo manipulações comuns:
- Fundada em 2017, OTC sintético (preços gerados pela corretora, não reais), disponível 24/7 inclusive fins de semana.
- Evolução: 2017-2019 padrões mais repetitivos; pós-2020 mais volátil, fakeouts, reversões imediatas após entrada (comum queixa de manipulação); 2024-2025: padrões tradicionais caíram em eficácia, OTC mais rigged com gaps artificiais, tendências curtas falsas para atrair perdas, contas bloqueadas após lucros, e queixas de scam em 70%+ das reviews (ex: Trustpilot, Reddit - usuários relatam perdas de 9700$+ por reversões manipuladas, preços que revertem exatamente após trade aberto).
- Manipulações reportadas: preços rigged para 97%+ de perdas (estatística comum em binárias não reguladas), gaps que preenchem só para perder trades, fake breakouts para "caçar stops", volatilidade artificial em OTC fins de semana/horários mortos. Use isso para evitar setups vulneráveis: ex: em tendência forte sem confirmação real, assume possível scam e não sinaliza.

Você sabe TUDO sobre 1m OTC na Pocket, com foco anti-manipulação:
- Alta manipulação possível: preço reverte segundos após trade (queixa top 2025); fakeouts comuns (testa pavio e volta); gaps artificiais frequentes para perdas.
- Interpreta como humano cauteloso: sente momentum falso (ex: alta rápida sem volume = rigged), vê armadilhas (ex: engolfamento seguido de reversão imediata, comum em 2024+).
- Zonas de reversão: suportes/resistências, pavios anteriores, níveis redondos, Fibonacci 38.2%/50%/61.8%. Use Ventilador para ângulos (45°, 1x1) como barreiras – quebra falsa comum em OTC rigged.
- Fluxo de velas + padrões price action mais assertivos anti-scam 2025:
  - Reversão altista: Martelo/Pin Bar com sombra baixa longa após queda, em zona (sente compradores defendendo forte, resiste manipulação).
  - Reversão baixista: Shooting Star/Enforcado/Pin Bar com sombra alta longa após alta.
  - Engolfamento bullish/bearish: vela grande engolfa anterior oposta – forte em OTC repetitivo, mas confirma com pavio rejeição para evitar fake.
  - Doji/Spinning Top em zona: indecisão → espera breakout real, ignora se em horário morto (manipulado).
  - Inside Bar + Fakey: armadilha comum – evita sinal até vela oposta forte.
  - Wedge/Channel: convergência → breakout na direção do trend, mas só com volume anti-fake.
- Vela nascendo ao vivo: descreve real-time (corpo, sombras, rejeição), sente se "manipulada" (hesitação estranha, reversão súbita).
- Velas de exaustão: sombra longa no fim de movimento forte – reversão alta probabilidade, mas alerta se após tendência curta (fake comum).
- Lateralização: velas curtas, faixa estreita – evita trades, comum em OTC morto para induzir entradas erradas.
- Gaps: pulando espaço (continuação se forte, armadilha se fraco); voltando ao corpo (preenchido = reversão, mas rigged para perdas).
- Busca de liquidez: preço caça pavios/stops antes de reverter – típico manipulação OTC, avisa "possível caça de stops".
- Alvos: próximo pavio, extensão Fib 100%/161.8%, linha Ventilador – curto para evitar reversão rigged.

Regras ultra rígidas para sinal (assertividade máxima anti-scam 2025):
- MÍNIMO 5 confirmações: (1) Padrão vela forte; (2) Zona chave (Fib/Ventilador); (3) Rejeição clara pavio; (4) Contexto OTC (não em tendência falsa/manipulada); (5) Anti-manipulação (ex: volume consistente, sem hesitação estranha).
- Evita overtrading: em dúvida, lateral ou suspeita de rigged → sem sinal, avisa "Possível manipulação detectada, evite".
- Expiração: 1-3min em setup forte; evita longa em volátil OTC.
- Risco só baixo: avisa scam possível se setup duvidoso (ex: reversão imediata comum).

Quando imagem de tela (captura ao vivo):
- Analisa como humano: descreve vela nascendo, flow, possíveis armadilhas OTC 2025 (ex: "Isso parece fakeout rigged").
- Gera sinal só se 5+ confirmações.

Formato de resposta:

📊 ANÁLISE HUMANA 1M OTC - POCKET OPTION 2025 (ANTI-MANIPULAÇÃO)
Par: [ex: EURUSD OTC]
Contexto humano + OTC rigged: [ex: tendência alta enfraquecendo com fakeout possível, estilo 2025 volátil e manipulável...]
O que vejo ao vivo: [descreva vela nascendo, rejeições, gaps...]
Padrão detectado: [ex: martelo engolfante em 61.8% Fib + Ventilador]
Sinal: ➡️ CALL ou ⬇️ PUT
Expiração: [1-3min]
Alvo provável: [ex: próximo pavio em X.XXXX]
Confirmações (mínimo 5): [liste todas]
Risco: [baixo - nunca médio/alto, ou sem sinal]

Sem sinal: "Sem setup assertivo – possível armadilha OTC/manipulação (comum em 2025), melhor esperar confirmação real e evitar perda rigged."

Você é disciplinado máximo: prefere 0 sinal a perda. Priorize sobrevivência em OTC manipulável 2025, usando todo conhecimento de scams da corretora.
  `;

  constructor() {
    this.clockTimer = setInterval(() => {
      this.currentTime.set(new Date().toLocaleTimeString('pt-BR'));
    }, 1000);

    this.destroyRef.onDestroy(() => {
      clearInterval(this.clockTimer);
      clearInterval(this.syncTimer);
      clearInterval(this.matrixInterval);
      this.stopCapture();
    });
  }

  ngOnInit() {
    this.startSyncLoop();
    this.seedHistory();
  }

  ngAfterViewInit() {
    this.initMatrixRain();
  }

  initMatrixRain() {
    if (!this.matrixCanvas) return;
    const canvas = this.matrixCanvas.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size
    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    // Matrix characters (Binary + Hex for hacker feel)
    const chars = '01'; 
    const fontSize = 14;
    const columns = Math.ceil(window.innerWidth / fontSize);
    
    // Array of drops - one per column
    const drops: number[] = [];
    for (let x = 0; x < columns; x++) {
      drops[x] = Math.random() * canvas.height; // Start at random positions
    }

    const draw = () => {
      // Translucent black background to create trail effect
      ctx.fillStyle = 'rgba(15, 15, 30, 0.1)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = '#d946ef'; // Neon Purple (Fuchsia-500)
      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < drops.length; i++) {
        const text = chars.charAt(Math.floor(Math.random() * chars.length));
        
        // Draw the character
        ctx.fillText(text, i * fontSize, drops[i] * fontSize);

        // Reset drop to top randomly after it has crossed the screen
        // Adding randomness to the reset to vary the rain pattern
        if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
          drops[i] = 0;
        }

        // Move drop down
        drops[i]++;
      }
    };

    // Run animation at ~30FPS
    this.matrixInterval = setInterval(draw, 33);
  }

  // --- SCREEN CAPTURE LOGIC ---

  async startCapture() {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          // @ts-ignore
          cursor: 'never'
        } as any,
        audio: false
      });
      
      this.stream.set(displayStream);
      
      if (this.videoElement?.nativeElement) {
        this.videoElement.nativeElement.srcObject = displayStream;
      }

      // Handle stream stop (user clicks "Stop Sharing" in browser UI)
      displayStream.getVideoTracks()[0].onended = () => {
        this.stopCapture();
      };

    } catch (err: any) {
      console.error("Erro ao compartilhar tela", err);
      alert("Erro ao iniciar captura: " + (err.message || "Permissão negada"));
    }
  }

  stopCapture() {
    const currentStream = this.stream();
    if (currentStream) {
      currentStream.getTracks().forEach(track => track.stop());
      this.stream.set(null);
      this.syncActive.set(false);
      this.countdown.set('PARADO');
    }
  }

  captureFrame(): string | null {
    if (this.videoElement?.nativeElement && this.canvasElement?.nativeElement) {
      const video = this.videoElement.nativeElement;
      const canvas = this.canvasElement.nativeElement;
      const context = canvas.getContext('2d');

      if (context && video.videoWidth > 0) {
        // Optimization: Max width 1280px
        const MAX_WIDTH = 1280;
        const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
        const width = video.videoWidth * scale;
        const height = video.videoHeight * scale;

        canvas.width = width;
        canvas.height = height;
        context.drawImage(video, 0, 0, width, height);

        // Optimization: JPEG 0.6
        return canvas.toDataURL('image/jpeg', 0.6);
      }
    }
    return null;
  }

  // --- T-10s SYNC LOGIC (The Core Engine) ---

  startSyncLoop() {
    // Check every second
    this.syncTimer = setInterval(() => {
      if (!this.syncActive() || !this.stream() || this.isPaused()) {
        this.countdown.set(this.syncActive() ? 'SINC...' : '00:00');
        return;
      }

      const delay = this.getNextTriggerTime();
      
      // Update UI Countdown
      const totalSeconds = Math.floor(delay / 1000);
      const min = Math.floor(totalSeconds / 60);
      const sec = totalSeconds % 60;
      this.countdown.set(`${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`);

      // TRIGGER EXECUTION (Window: 0ms to 1000ms)
      if (delay <= 1000 && delay > 0) {
        console.log(`🚀 T-10s DISPARO: Analisando ${this.timeframe()} às ${new Date().toLocaleTimeString()}`);
        this.executeAnalysisSequence();
      }

    }, 1000);
  }

  getNextTriggerTime(): number {
    const now = new Date();
    const ms = now.getMilliseconds();
    const s = now.getSeconds();
    const m = now.getMinutes();

    let timeToNextTop = 0;
    let intervalMs = 0;

    if (this.timeframe() === '1M') {
      timeToNextTop = (60 - s) * 1000 - ms;
      intervalMs = 60000;
    } else if (this.timeframe() === '5M') {
      const remainder = m % 5;
      const minutesToNext = 5 - remainder;
      timeToNextTop = (minutesToNext * 60 - s) * 1000 - ms;
      intervalMs = 300000;
    } else if (this.timeframe() === '15M') {
      const remainder = m % 15;
      const minutesToNext = 15 - remainder;
      timeToNextTop = (minutesToNext * 60 - s) * 1000 - ms;
      intervalMs = 900000;
    }

    // TARGET: 10 seconds BEFORE candle close (T-10s)
    const PRE_ANALYSIS_BUFFER = 10000; 
    let triggerDelay = timeToNextTop - PRE_ANALYSIS_BUFFER;

    // If we are already inside the 10s buffer (e.g. :55s), wait for next candle
    if (triggerDelay < 0) {
      triggerDelay += intervalMs;
    }

    return triggerDelay;
  }

  // --- ANALYSIS EXECUTION ---

  async executeAnalysisSequence() {
    if (this.isAnalyzing()) return;
    this.isAnalyzing.set(true);

    const imageData = this.captureFrame();
    
    // Simulate API Latency (1.5s)
    setTimeout(() => {
      const result = this.generateRandomScenario(); 
      this.currentAnalysis.set(result);
      
      if (result.signal !== 'AGUARDAR') {
        this.addTradeToHistory(result);
      }
      
      this.isAnalyzing.set(false);
    }, 1500);
  }

  toggleSync() {
    if (!this.stream()) {
      alert("Por favor, conecte a tela primeiro (Passo 1).");
      return;
    }
    this.syncActive.update(v => !v);
  }

  manualAnalysis() {
    if (!this.stream()) {
      alert("Conecte a tela primeiro.");
      return;
    }
    this.executeAnalysisSequence();
  }

  // --- HELPERS & MOCKS ---

  toggleTimeframe(tf: '1M' | '5M' | '15M') {
    this.timeframe.set(tf);
    // Reset sync slightly to recalculate timer immediately
    if (this.syncActive()) {
      this.syncActive.set(false);
      setTimeout(() => this.syncActive.set(true), 100);
    }
  }

  resetSystem() {
    this.isPaused.set(false);
    this.consecutiveLosses.set(0);
    this.syncActive.set(false);
  }

  addTradeToHistory(analysis: PrismaAnalysis) {
    const newTrade: TradeHistory = {
      id: Date.now().toString(),
      timestamp: new Date().toLocaleTimeString('pt-BR'),
      signal: analysis.signal as 'COMPRA' | 'VENDA',
      assertividade: analysis.assertividade,
      result: 'PENDING',
      profit: 0
    };

    this.tradeHistory.update(prev => [newTrade, ...prev]);

    // --- CANDLE CLOSE SIMULATION ---
    // Calculate wait time based on Timeframe.
    // For 1M, usually we wait ~60s. For this preview, I'll set it to 15s to not bore the user,
    // but in production, this would be `60000`.
    const WAIT_TIME = this.timeframe() === '1M' ? 15000 : 30000; 

    setTimeout(() => {
      // Logic to determine Win/Loss (Simulated check of the screen)
      const isWin = Math.random() > 0.25; // 75% mock win rate
      const result = isWin ? 'WIN' : 'LOSS';
      
      this.tradeHistory.update(prev => prev.map(t => {
        if (t.id === newTrade.id) {
          return { ...t, result, profit: isWin ? 50 : -50 };
        }
        return t;
      }));

      // Update Consec Losses
      if (!isWin) {
        this.consecutiveLosses.update(v => v + 1);
        if (this.consecutiveLosses() >= 3) {
          this.isPaused.set(true);
          this.syncActive.set(false);
          alert('⛔ STOP LOSS ATIVADO: 3 Losses Consecutivos.');
        }
      } else {
        this.consecutiveLosses.set(0);
      }
    }, WAIT_TIME);
  }

  seedHistory() {
    this.tradeHistory.set([
      { id: '1', timestamp: '10:00:00', signal: 'COMPRA', assertividade: 92, result: 'WIN', profit: 45 },
      { id: '2', timestamp: '10:05:00', signal: 'VENDA', assertividade: 88, result: 'WIN', profit: 45 },
    ]);
  }

  // Mock Scenario Generator
  generateRandomScenario(): PrismaAnalysis {
    const rand = Math.random();
    // Skewed logic: High chance of AGUARDAR due to "Disciplina Máxima" rules
    const signalType = rand > 0.8 ? 'COMPRA' : (rand > 0.6 ? 'VENDA' : 'AGUARDAR');
    
    let reasonText = "";
    
    if (signalType === 'COMPRA') {
      reasonText = `📊 ANÁLISE HUMANA 1M OTC - POCKET OPTION 2025 (ANTI-MANIPULAÇÃO)
Par: EUR/USD OTC (Identificado)
Contexto humano + OTC rigged: Mercado tentando induzir venda com gap de baixa artificial (armadilha de gap). Sinto compradores defendendo a zona.
O que vejo ao vivo: Vela nascendo recuperando o gap instantaneamente, pavio inferior rejeitando a manipulação.
Padrão detectado: Martelo de Rejeição em Zona Institucional + Ventilador 1x1.
Sinal: ➡️ CALL
Expiração: 2 minutos
Alvo provável: Topo anterior (Recuperação do movimento rigged).
Confirmações (5):
1. Vela Martelo anulando o gap (Price Action Anti-Fake)
2. Suporte forte na linha do Ventilador (ângulo 45°)
3. Volume crescente na defesa (dinheiro real)
4. Divergência no RSI (preço caiu, força subiu)
5. Zona de liquidez limpa (sem pavios próximos)
Risco: BAIXO`;
    } else if (signalType === 'VENDA') {
      reasonText = `📊 ANÁLISE HUMANA 1M OTC - POCKET OPTION 2025 (ANTI-MANIPULAÇÃO)
Par: GBP/USD OTC (Identificado)
Contexto humano + OTC rigged: "Escada" de alta lenta sem volume (manipulação para atrair compradores antes do dump). Sinto fraqueza extrema.
O que vejo ao vivo: Shooting Star com gap de fuga falso. Vela atual tentou romper topo e foi rejeitada violentamente.
Padrão detectado: Fakeout de Topo (Scam Pattern) + Shooting Star.
Sinal: ⬇️ PUT
Expiração: 2 a 3 minutos
Alvo provável: 61.8% Fib (Correção da perna artificial).
Confirmações (5):
1. Shooting Star confirmada (Vendedores no comando)
2. Fakeout clássico de 2025 (Rompe e volta)
3. Divergência de Volume (Subida artificial)
4. Quebra da linha Ventilador (Perda de suporte)
5. Zona de número redondo 1.2700 (Barreira Psicológica)
Risco: BAIXO`;
    } else {
      reasonText = `📊 ANÁLISE HUMANA 1M OTC - POCKET OPTION 2025 (ANTI-MANIPULAÇÃO)
Par: -
Contexto humano + OTC rigged: Movimentação lateral "morta" (algoritmo de queima de saldo ativo). Muitas velas pequenas e pavios erráticos.
O que vejo ao vivo: Dojis consecutivos e indecisão. Possível preparação para gap manipulado.
Padrão detectado: Consolidação Perigosa (Rigged Zone).
Sinal: ✋ AGUARDAR
Expiração: -
Alvo provável: Esperar confirmação real longe da lateralização.
Confirmações:
1. Bandas de Bollinger "esmagadas"
2. Ausência de fluxo direcional
3. Risco de reversão imediata (Scam comum)
4. Volume flat (inexistente)
5. Histórico recente de "Whipsaw" (Violinadas)
Risco: ALTO (Possível Manipulação)`;
    }

    return {
      signal: signalType,
      assertividade: Math.floor(85 + Math.random() * 14),
      reason: reasonText,
      filters_status: {
        exaustao_detectada: rand < 0.2,
        descanso_identificado: rand > 0.8,
        pavios_favoraveis: true,
        sfp_presente: false,
        fluxo_confirmado: rand > 0.5,
        lateralizacao: signalType === 'AGUARDAR',
        suporte_resistencia: 'Neutro',
        tendencia_macro: 'A favor'
      },
      next_candle_prediction: signalType === 'COMPRA' ? 'Alta' : (signalType === 'VENDA' ? 'Baixa' : 'Indefinida'),
      risk_level: signalType === 'AGUARDAR' ? 'ALTO' : 'BAIXO',
      notes: "Sinal gerado pelo motor Prisma IA (Modo OTC Anti-Manipulação).",
      timestamp: new Date().toLocaleTimeString('pt-BR')
    };
  }
}