// ============================================================================
// Cloudflare Worker · UC MNI Test · Protótipo de integração MNI 2.2.2
// ----------------------------------------------------------------------------
// Stateless: recebe credenciais via POST, repassa para Projudi/TJGO via SOAP,
// converte resposta XML para JSON, devolve para o cliente.
//
// IMPORTANTE: este Worker é apenas um proxy. Não armazena, não loga, não cacheia
// credenciais ou dados de processo. Toda chamada é independente.
//
// PASSOS PARA INSTALAR:
// 1. dash.cloudflare.com → Workers & Pages → Create → Create Worker
// 2. Nome: uc-mni
// 3. Deploy do "Hello World" → Edit code
// 4. Apagar tudo, colar este código completo
// 5. Deploy
// 6. Anotar a URL gerada (https://uc-mni.SEU-USUARIO.workers.dev)
// ============================================================================

const TJGO_PROJUDI_MNI = 'https://projudi.tjgo.jus.br/IntercomunicacaoService';
const MNI_NAMESPACE = 'http://www.cnj.jus.br/servicos-mni';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400'
};

export default {
  async fetch(req) {
    // Preflight CORS
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // Health check
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse({
        ok: true,
        service: 'UC MNI Test Proxy',
        target: TJGO_PROJUDI_MNI,
        endpoints: ['POST /consultarProcesso']
      });
    }

    if (url.pathname === '/consultarProcesso' && req.method === 'POST') {
      return handleConsultarProcesso(req);
    }

    return jsonResponse({ error: 'not_found', path: url.pathname }, 404);
  }
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS }
  });
}

async function handleConsultarProcesso(req) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return jsonResponse({ error: 'invalid_body', message: 'POST body must be JSON' }, 400);
  }

  const { cpf, senha, cnj, incluirDocumentos = false, movimentos = true } = body;

  // Validações
  if (!cpf || !senha || !cnj) {
    return jsonResponse({
      error: 'missing_fields',
      message: 'Campos obrigatórios: cpf, senha, cnj'
    }, 400);
  }

  // Limpa CPF (deixa só dígitos)
  const cpfClean = String(cpf).replace(/\D/g, '');
  const cnjClean = String(cnj).replace(/\D/g, '');

  if (cpfClean.length !== 11) {
    return jsonResponse({ error: 'invalid_cpf', message: 'CPF deve ter 11 dígitos' }, 400);
  }
  if (cnjClean.length !== 20) {
    return jsonResponse({ error: 'invalid_cnj', message: 'CNJ deve ter 20 dígitos' }, 400);
  }

  // Monta envelope SOAP
  const soapEnvelope = buildConsultarProcessoEnvelope({
    cpf: cpfClean,
    senha,
    cnj: cnjClean,
    incluirDocumentos,
    movimentos
  });

  // Chama o Projudi/TJGO
  let projudiResponse;
  try {
    const r = await fetch(TJGO_PROJUDI_MNI, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'consultarProcesso'
      },
      body: soapEnvelope
    });
    projudiResponse = {
      status: r.status,
      body: await r.text()
    };
  } catch (err) {
    return jsonResponse({
      error: 'projudi_unreachable',
      message: 'Não foi possível conectar ao Projudi: ' + err.message
    }, 502);
  }

  if (projudiResponse.status !== 200) {
    return jsonResponse({
      error: 'projudi_error',
      status: projudiResponse.status,
      message: 'Projudi retornou HTTP ' + projudiResponse.status,
      raw: projudiResponse.body.substring(0, 2000)
    }, 502);
  }

  // Parse da resposta SOAP
  let parsed;
  try {
    parsed = parseConsultarProcessoResponse(projudiResponse.body);
  } catch (err) {
    return jsonResponse({
      error: 'parse_error',
      message: 'Erro ao processar resposta do Projudi: ' + err.message,
      raw: projudiResponse.body.substring(0, 3000)
    }, 502);
  }

  // Verifica se foi sucesso
  if (!parsed.sucesso) {
    return jsonResponse({
      error: 'projudi_failure',
      mensagem: parsed.mensagem || 'Falha não especificada',
      raw_excerpt: projudiResponse.body.substring(0, 1500)
    }, 400);
  }

  return jsonResponse({
    sucesso: true,
    processo: parsed.processo
  });
}

// ============================================================================
// SOAP Envelope Builder
// ============================================================================
function buildConsultarProcessoEnvelope({ cpf, senha, cnj, incluirDocumentos, movimentos }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:mni="${MNI_NAMESPACE}">
  <soap:Body>
    <mni:consultarProcesso>
      <mni:idConsultante>${escapeXml(cpf)}</mni:idConsultante>
      <mni:senhaConsultante>${escapeXml(senha)}</mni:senhaConsultante>
      <mni:numeroProcesso>${escapeXml(cnj)}</mni:numeroProcesso>
      <mni:movimentos>${movimentos}</mni:movimentos>
      <mni:incluirCabecalho>true</mni:incluirCabecalho>
      <mni:incluirDocumentos>${incluirDocumentos}</mni:incluirDocumentos>
    </mni:consultarProcesso>
  </soap:Body>
</soap:Envelope>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ============================================================================
// SOAP Response Parser
// ----------------------------------------------------------------------------
// Cloudflare Workers não tem DOMParser nativo robusto, então fazemos parse
// por regex direcionado nas tags conhecidas do MNI 2.2.2. Não é parser XML
// completo — funciona porque o esquema é estável e bem-definido.
// ============================================================================
function parseConsultarProcessoResponse(xml) {
  // Detecta se é fault SOAP
  const faultMatch = xml.match(/<(?:soap:)?Fault[^>]*>([\s\S]*?)<\/(?:soap:)?Fault>/i);
  if (faultMatch) {
    const faultStr = faultMatch[1];
    const reason = (faultStr.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i) || [])[1] ||
                   (faultStr.match(/<reason[^>]*>([\s\S]*?)<\/reason>/i) || [])[1] ||
                   'SOAP Fault não especificado';
    return { sucesso: false, mensagem: reason.trim() };
  }

  // Verifica tag de sucesso/falha
  const sucessoMatch = xml.match(/<(?:[\w-]+:)?sucesso[^>]*>(.*?)<\/(?:[\w-]+:)?sucesso>/);
  const sucesso = sucessoMatch ? sucessoMatch[1].trim().toLowerCase() === 'true' : false;

  if (!sucesso) {
    const mensagemMatch = xml.match(/<(?:[\w-]+:)?mensagem[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?mensagem>/);
    return {
      sucesso: false,
      mensagem: mensagemMatch ? mensagemMatch[1].trim() : 'Resposta sem mensagem de erro'
    };
  }

  // Sucesso — extrai dados do processo
  const processo = {
    cabecalho: extractCabecalho(xml),
    polos: extractPolos(xml),
    movimentos: extractMovimentos(xml),
    documentos: extractDocumentos(xml)
  };

  return { sucesso: true, processo };
}

function extractCabecalho(xml) {
  const cabBlockMatch = xml.match(/<(?:[\w-]+:)?dadosBasicos[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?dadosBasicos>/);
  if (!cabBlockMatch) {
    // Tentar encontrar atributos diretos no elemento dadosBasicos
    const attrsMatch = xml.match(/<(?:[\w-]+:)?dadosBasicos\s+([^>]+)\/?>/);
    if (attrsMatch) {
      return parseAttributes(attrsMatch[1]);
    }
    return {};
  }

  const block = cabBlockMatch[1];
  const dadosBasicosTag = xml.match(/<(?:[\w-]+:)?dadosBasicos\s+([^>]*?)>/);
  const attrs = dadosBasicosTag ? parseAttributes(dadosBasicosTag[1]) : {};

  // Extrai sub-elementos
  const orgaoJulgadorMatch = block.match(/<(?:[\w-]+:)?orgaoJulgador\s+([^>]+?)\/?>/);
  if (orgaoJulgadorMatch) {
    attrs.orgaoJulgador = parseAttributes(orgaoJulgadorMatch[1]);
  }

  // Assuntos
  const assuntos = [];
  const assuntoRegex = /<(?:[\w-]+:)?assunto[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?assunto>/g;
  let am;
  while ((am = assuntoRegex.exec(block)) !== null) {
    const codigoMatch = am[1].match(/<(?:[\w-]+:)?codigoNacional[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?codigoNacional>/);
    const principalMatch = am[1].match(/principal="(true|false)"/);
    if (codigoMatch) {
      assuntos.push({
        codigo: codigoMatch[1].trim(),
        principal: principalMatch ? principalMatch[1] === 'true' : false
      });
    }
  }
  if (assuntos.length) attrs.assuntos = assuntos;

  return attrs;
}

function extractPolos(xml) {
  const polos = { ATIVO: [], PASSIVO: [] };
  const poloRegex = /<(?:[\w-]+:)?polo\s+polo="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?polo>/g;
  let pm;
  while ((pm = poloRegex.exec(xml)) !== null) {
    const tipo = pm[1].toUpperCase();
    const polo = (tipo === 'AT') ? 'ATIVO' : (tipo === 'PA') ? 'PASSIVO' : tipo;
    if (!polos[polo]) polos[polo] = [];

    const partesXml = pm[2];
    const parteRegex = /<(?:[\w-]+:)?parte[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?parte>/g;
    let parteM;
    while ((parteM = parteRegex.exec(partesXml)) !== null) {
      const parteContent = parteM[1];
      const pessoaMatch = parteContent.match(/<(?:[\w-]+:)?pessoa\s+([^>]+?)>/);
      let parte = pessoaMatch ? parseAttributes(pessoaMatch[1]) : {};

      // Documento (CPF/CNPJ)
      const docMatch = parteContent.match(/<(?:[\w-]+:)?documento\s+([^>]+?)\/?>/);
      if (docMatch) {
        const docAttrs = parseAttributes(docMatch[1]);
        parte.documento = docAttrs.codigoDocumento || '';
        parte.tipoDocumento = docAttrs.tipoDocumento || '';
      }

      // Advogados (representantes/advogados)
      const advs = [];
      const advRegex = /<(?:[\w-]+:)?advogado[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?advogado>/g;
      let advM;
      while ((advM = advRegex.exec(parteContent)) !== null) {
        const advContent = advM[1];
        const nomeMatch = advContent.match(/<(?:[\w-]+:)?nome[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?nome>/);
        const oabMatch = advContent.match(/<(?:[\w-]+:)?inscricao[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?inscricao>/);
        if (nomeMatch || oabMatch) {
          advs.push({
            nome: nomeMatch ? nomeMatch[1].trim() : '',
            oab: oabMatch ? oabMatch[1].trim() : ''
          });
        }
      }
      if (advs.length) parte.advogados = advs;

      polos[polo].push(parte);
    }
  }
  return polos;
}

function extractMovimentos(xml) {
  const movimentos = [];
  const movRegex = /<(?:[\w-]+:)?movimento[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?movimento>/g;
  let mm;
  while ((mm = movRegex.exec(xml)) !== null) {
    const movContent = mm[1];
    const movTagMatch = xml.substring(mm.index, mm.index + 200).match(/<(?:[\w-]+:)?movimento\s+([^>]+?)>/);
    const movAttrs = movTagMatch ? parseAttributes(movTagMatch[1]) : {};

    const movNacMatch = movContent.match(/<(?:[\w-]+:)?movimentoNacional\s+([^>]+?)\/?>/);
    const movLocMatch = movContent.match(/<(?:[\w-]+:)?movimentoLocal\s+([^>]+?)\/?>/);

    const mov = {
      data: movAttrs.dataHora || '',
      ...movAttrs
    };

    if (movNacMatch) {
      const a = parseAttributes(movNacMatch[1]);
      mov.codigoNacional = a.codigoNacional || a.codigo || '';
      mov.descricaoNacional = a.descricao || '';
    }
    if (movLocMatch) {
      const a = parseAttributes(movLocMatch[1]);
      mov.descricaoLocal = a.descricao || '';
    }

    // Complementos
    const complRegex = /<(?:[\w-]+:)?complemento[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?complemento>/g;
    const complementos = [];
    let cm;
    while ((cm = complRegex.exec(movContent)) !== null) {
      complementos.push(cm[1].trim());
    }
    if (complementos.length) mov.complementos = complementos;

    movimentos.push(mov);
  }

  // Ordena do mais recente para o mais antigo
  movimentos.sort((a, b) => (b.data || '').localeCompare(a.data || ''));

  return movimentos;
}

function extractDocumentos(xml) {
  const documentos = [];
  const docRegex = /<(?:[\w-]+:)?documento\s+([^>]+?)\/?>/g;
  let dm;
  while ((dm = docRegex.exec(xml)) !== null) {
    const attrs = parseAttributes(dm[1]);
    // Filtra só documentos do processo (têm idDocumento), não documentos de partes
    if (attrs.idDocumento) {
      documentos.push(attrs);
    }
  }
  return documentos;
}

// Parser auxiliar para atributos XML em strings tipo: chave="valor" outraChave="outroValor"
function parseAttributes(attrString) {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}
