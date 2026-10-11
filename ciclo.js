/**
 * CICLO.JS — Ciclo financeiro do cliente ("o meu mês começa quando eu recebo")
 * ================================================
 * Padrão: script global (IIFE `CicloModule`). Sem import/export.
 * Usado por: app.js (cliente), gamificacao.js, dashboards.js e
 * planejamentos.js (admin). Todos funcionam sem ele (mês-calendário).
 *
 * Tipos de ciclo (colunas clientes.ciclo_tipo / clientes.ciclo_dia):
 *   'dia_mes'      → recebe todo dia N (1–31). Dia 27 → ciclo 27/05 a 26/06.
 *                    Meses curtos: dia 31 em fevereiro vira o último dia.
 *   'dia_util'     → recebe no Nº dia útil (seg–sex, sem feriados).
 *   'sem_dia_fixo' → renda variável: usa o mês normal (dia 1 ao fim).
 * Dia 1 do mês e "sem dia fixo" equivalem ao mês-calendário.
 *
 * Datas sempre no horário local; strings no formato 'AAAA-MM-DD'.
 */

const CicloModule = (() => {
    const PADRAO = { tipo: 'dia_mes', dia: 1 };
    const pad = (n) => String(n).padStart(2, '0');
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const meiaNoite = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const somarDias = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

    /** Aceita {tipo, dia}, {ciclo_tipo, ciclo_dia} ou nada. */
    function normalizar(bruto) {
        if (!bruto) return { ...PADRAO };
        const tipo = bruto.tipo || bruto.ciclo_tipo || 'dia_mes';
        let dia = parseInt(bruto.dia ?? bruto.ciclo_dia, 10);
        if (tipo === 'sem_dia_fixo') return { tipo, dia: 1 };
        if (tipo === 'dia_util') return { tipo, dia: Math.min(Math.max(dia || 5, 1), 15) };
        return { tipo: 'dia_mes', dia: Math.min(Math.max(dia || 1, 1), 31) };
    }

    /** Linha de `clientes` (ou da view do admin) → configuração. */
    function deLinha(linha) {
        if (!linha) return { ...PADRAO };
        return normalizar({ tipo: linha.ciclo_tipo, dia: linha.ciclo_dia });
    }

    function ehMesCalendario(cfg) {
        const c = normalizar(cfg);
        return c.tipo === 'sem_dia_fixo' || (c.tipo === 'dia_mes' && c.dia === 1);
    }

    /** Dia em que o ciclo começa dentro do mês-calendário (ano, mesIdx 0–11; aceita estouro). */
    function inicioDoMes(cfg, ano, mesIdx) {
        const c = normalizar(cfg);
        const base = new Date(ano, mesIdx, 1);
        const a = base.getFullYear(), m = base.getMonth();
        if (c.tipo === 'sem_dia_fixo') return new Date(a, m, 1);
        if (c.tipo === 'dia_util') {
            let d = new Date(a, m, 1), uteis = 0;
            while (d.getMonth() === m) {
                const dow = d.getDay();
                if (dow !== 0 && dow !== 6 && ++uteis === c.dia) return d;
                d = somarDias(d, 1);
            }
            return somarDias(d, -1); // mês com menos dias úteis que o pedido
        }
        const ultimo = new Date(a, m + 1, 0).getDate();
        return new Date(a, m, Math.min(c.dia, ultimo));
    }

    function formatarBR(d) {
        const x = d instanceof Date ? d : new Date(`${String(d).slice(0, 10)}T00:00:00`);
        return `${pad(x.getDate())}/${pad(x.getMonth() + 1)}`;
    }

    function montar(cfg, inicioDate, proximoInicio) {
        const fimDate = somarDias(proximoInicio, -1);
        return {
            inicio: iso(inicioDate), fim: iso(fimDate),
            inicioDate, fimDate,
            rotulo: `${formatarBR(inicioDate)} a ${formatarBR(fimDate)}`,
            rotuloCurto: `${formatarBR(inicioDate)}–${formatarBR(fimDate)}`
        };
    }

    /** Ciclo que contém a data. */
    function cicloQueContem(cfg, data) {
        const d = meiaNoite(data instanceof Date ? data : new Date(`${String(data).slice(0, 10)}T00:00:00`));
        const a = d.getFullYear(), m = d.getMonth();
        const inicioEsteMes = inicioDoMes(cfg, a, m);
        if (d >= inicioEsteMes) return montar(cfg, inicioEsteMes, inicioDoMes(cfg, a, m + 1));
        return montar(cfg, inicioDoMes(cfg, a, m - 1), inicioEsteMes);
    }

    /** offset 0 = ciclo de hoje, -1 = anterior, +1 = próximo. */
    function cicloPorOffset(cfg, hoje, offset = 0) {
        const atual = cicloQueContem(cfg, hoje || new Date());
        const a = atual.inicioDate.getFullYear(), m = atual.inicioDate.getMonth();
        return montar(cfg, inicioDoMes(cfg, a, m + offset), inicioDoMes(cfg, a, m + offset + 1));
    }

    /** Texto amigável: "Todo dia 27", "5º dia útil", "Mês normal". */
    function descrever(cfg) {
        const c = normalizar(cfg);
        if (c.tipo === 'sem_dia_fixo') return 'Sem dia fixo — mês normal (dia 1 ao último dia)';
        if (c.tipo === 'dia_util') return `${c.dia}º dia útil de cada mês`;
        return c.dia === 1 ? 'Dia 1 — mês normal' : `Todo dia ${c.dia}`;
    }

    return { normalizar, deLinha, ehMesCalendario, inicioDoMes, cicloQueContem, cicloPorOffset, formatarBR, descrever, iso };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CicloModule;

console.log('✅ ciclo.js carregado');
