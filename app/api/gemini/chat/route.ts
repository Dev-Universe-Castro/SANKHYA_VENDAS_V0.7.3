import { NextRequest } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { cookies } from 'next/headers';
import { redisCacheService } from '@/lib/redis-cache-service';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Função helper para fetch com timeout
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    console.error(`⚠️ Timeout/erro ao buscar ${url}:`, error);
    throw error;
  }
}

// Função para buscar dados do sistema (otimizada com cache)
async function analisarDadosDoSistema(userId: number, userName: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:5000';
    console.log('🔍 [1/4] Iniciando busca de dados do sistema...');

    // ETAPA 1: Buscar parceiros e produtos (sempre do cache usando chaves corretas)
    let parceiros: any[] = [];
    let produtos: any[] = [];

    console.log('📦 [1/4] Buscando parceiros e produtos do cache...');
    
    // Buscar parceiros - tentar múltiplas chaves de cache comuns
    const cacheKeysParceiros = [
      'parceiros:list:1:50:::',
      'parceiros:list:1:20:::',
      'parceiros:list:1:10:::'
    ];
    
    for (const cacheKey of cacheKeysParceiros) {
      const parceirosCache = await redisCacheService.get<any>(cacheKey);
      if (parceirosCache?.parceiros && parceirosCache.parceiros.length > 0) {
        parceiros = parceirosCache.parceiros.slice(0, 15);
        console.log(`✅ ${parceiros.length} parceiros do cache (chave: ${cacheKey})`);
        break;
      }
    }

    // Se não encontrou no cache, buscar da API
    if (parceiros.length === 0) {
      console.log('🌐 Cache de parceiros vazio, buscando da API...');
      try {
        const parceirosResponse = await fetchWithTimeout(
          `${baseUrl}/api/sankhya/parceiros?page=1&pageSize=15`,
          {},
          8000
        );
        if (parceirosResponse.ok) {
          const parceirosData = await parceirosResponse.json();
          parceiros = parceirosData.parceiros || [];
          console.log(`✅ ${parceiros.length} parceiros da API`);
        }
      } catch (error) {
        console.error('⚠️ Erro ao buscar parceiros da API:', error);
      }
    }

    // Buscar produtos - tentar múltiplas chaves de cache comuns (ORDEM IMPORTA!)
    const cacheKeysProdutos = [
      'produtos:list:all',        // Chave principal usada no prefetch
      'produtos:list:1:50::',
      'produtos:list:1:100::',
      'produtos:list:1:20::'
    ];
    
    for (const cacheKey of cacheKeysProdutos) {
      const produtosCache = await redisCacheService.get<any>(cacheKey);
      console.log(`🔍 Tentando chave: ${cacheKey}`, {
        temCache: !!produtosCache,
        temProdutos: !!produtosCache?.produtos,
        quantidade: produtosCache?.produtos?.length || 0
      });
      
      if (produtosCache?.produtos && produtosCache.produtos.length > 0) {
        // Não filtrar por estoque aqui - deixar a IA ver todos os produtos
        produtos = produtosCache.produtos.slice(0, 20);
        console.log(`✅ ${produtos.length} produtos do cache (chave: ${cacheKey})`);
        break;
      }
    }

    // Se não encontrou no cache, buscar da API
    if (produtos.length === 0) {
      console.log('🌐 Cache de produtos vazio, buscando da API...');
      try {
        const produtosResponse = await fetchWithTimeout(
          `${baseUrl}/api/sankhya/produtos?page=1&pageSize=20`,
          {},
          8000
        );
        if (produtosResponse.ok) {
          const produtosData = await produtosResponse.json();
          produtos = (produtosData.produtos || []).slice(0, 20);
          console.log(`✅ ${produtos.length} produtos da API`);
        }
      } catch (error) {
        console.error('⚠️ Erro ao buscar produtos da API:', error);
      }
    }

    // ETAPA 2: Buscar leads (dados críticos)
    console.log('📊 [2/4] Buscando leads do usuário...');
    let leads: any[] = [];
    try {
      const leadsResponse = await fetchWithTimeout(`${baseUrl}/api/leads`, {
        headers: { 'Cookie': `user=${JSON.stringify({ id: userId })}` }
      }, 8000);

      if (leadsResponse.ok) {
        const leadsData = await leadsResponse.json();
        leads = Array.isArray(leadsData) ? leadsData.slice(0, 10) : [];
        console.log(`✅ ${leads.length} leads carregados`);
      }
    } catch (error) {
      console.error('⚠️ Erro ao buscar leads (continuando):', error);
    }

    // ETAPA 3: Buscar atividades dos leads (NOVO - dados críticos)
    console.log('📋 [3/4] Buscando atividades dos leads...');
    let atividades: any[] = [];
    try {
      const atividadesResponse = await fetchWithTimeout(
        `${baseUrl}/api/leads/atividades?ativo=S`,
        {},
        6000
      );

      if (atividadesResponse.ok) {
        const atividadesData = await atividadesResponse.json();
        atividades = Array.isArray(atividadesData) ? atividadesData.slice(0, 15) : [];
        console.log(`✅ ${atividades.length} atividades carregadas`);
      }
    } catch (error) {
      console.error('⚠️ Erro ao buscar atividades (continuando):', error);
    }

    // ETAPA 4: Buscar pedidos (apenas resumo)
    console.log('💰 [4/4] Buscando resumo de pedidos...');
    let totalPedidos = 0;
    let valorTotalPedidos = 0;
    let pedidosRecentes: any[] = [];
    try {
      const pedidosResponse = await fetchWithTimeout(
        `${baseUrl}/api/sankhya/pedidos/listar?userId=${userId}`, 
        {}, 
        6000
      );

      if (pedidosResponse.ok) {
        const pedidosData = await pedidosResponse.json();
        const pedidos = Array.isArray(pedidosData) ? pedidosData : (pedidosData.pedidos || []);
        pedidosRecentes = pedidos.slice(0, 5); // Apenas 5 mais recentes
        totalPedidos = pedidos.length;
        valorTotalPedidos = pedidos.reduce((sum: number, p: any) => sum + (parseFloat(p.VLRNOTA) || 0), 0);
        console.log(`✅ ${totalPedidos} pedidos encontrados (R$ ${valorTotalPedidos.toFixed(2)})`);
      }
    } catch (error) {
      console.error('⚠️ Erro ao buscar pedidos (continuando):', error);
    }

    console.log(`📊 Dados coletados: ${leads.length} leads, ${atividades.length} atividades, ${parceiros.length} parceiros (cache), ${produtos.length} produtos (cache), ${totalPedidos} pedidos`);

    return {
      leads,
      atividades,
      parceiros,
      produtos,
      pedidosRecentes,
      userName,
      totalLeads: leads.length,
      totalAtividades: atividades.length,
      totalParceiros: parceiros.length,
      totalProdutos: produtos.length,
      totalPedidos,
      valorTotalPedidos
    };
  } catch (error) {
    console.error('❌ Erro ao analisar dados do sistema:', error);
    return {
      leads: [],
      atividades: [],
      parceiros: [],
      produtos: [],
      pedidosRecentes: [],
      userName,
      totalLeads: 0,
      totalAtividades: 0,
      totalParceiros: 0,
      totalProdutos: 0,
      totalPedidos: 0,
      valorTotalPedidos: 0
    };
  }
}

const SYSTEM_PROMPT = `Você é um Assistente de Vendas Inteligente integrado em uma ferramenta de CRM/Força de Vendas chamada Sankhya CRM.

SEU PAPEL E RESPONSABILIDADES:
- Ajudar vendedores a identificar oportunidades de vendas
- Sugerir ações estratégicas para fechar negócios
- Analisar leads e recomendar próximos passos
- Identificar clientes potenciais com maior chance de conversão
- Sugerir produtos que podem interessar aos clientes
- Alertar sobre leads em risco ou oportunidades urgentes

DADOS QUE VOCÊ TEM ACESSO:
- Leads: oportunidades de vendas com informações sobre valor, estágio, parceiro associado
- Parceiros: clientes e prospects cadastrados no sistema
- Produtos: catálogo REAL de produtos com estoque atual (USE APENAS OS PRODUTOS FORNECIDOS NO CONTEXTO)
- Pedidos: histórico de vendas

⚠️ REGRA IMPORTANTE SOBRE PRODUTOS:
Você receberá uma lista completa de produtos com suas quantidades em estoque.
NUNCA mencione produtos que não estejam explicitamente listados nos dados fornecidos.
Se não houver produtos na lista, informe que não há produtos cadastrados no momento.

COMO VOCÊ DEVE AGIR:
1. Sempre analise os dados fornecidos antes de responder
2. Seja proativo em sugerir vendas e ações comerciais
3. Identifique padrões e oportunidades nos dados
4. Use métricas e números concretos em suas análises
5. Seja direto e focado em resultados de vendas
6. Priorize leads com maior valor e urgência
7. Sugira próximos passos claros e acionáveis

FORMATO DAS RESPOSTAS:
- Use emojis para destacar informações importantes (📊 💰 🎯 ⚠️ ✅)
- Organize informações em listas quando relevante
- Destaque valores monetários e datas importantes
- Seja conciso mas informativo

Sempre que o usuário fizer uma pergunta, considere os dados do sistema disponíveis para dar respostas contextualizadas e acionáveis.`;

export async function POST(request: NextRequest) {
  try {
    const { message, history } = await request.json();

    // Obter usuário autenticado
    const cookieStore = await cookies();
    const userCookie = cookieStore.get('user');
    let userId = 0;
    let userName = 'Usuário';

    if (userCookie) {
      try {
        const user = JSON.parse(userCookie.value);
        userId = user.id;
        userName = user.name || 'Usuário';
      } catch (e) {
        console.error('Erro ao parsear cookie:', e);
      }
    }

    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1500,
      }
    });

    // Montar histórico com prompt de sistema
    const chatHistory = [
      {
        role: 'user',
        parts: [{ text: SYSTEM_PROMPT }],
      },
      {
        role: 'model',
        parts: [{ text: 'Entendido! Sou seu Assistente de Vendas no Sankhya CRM. Estou pronto para analisar seus dados e ajudar você a vender mais. Como posso ajudar?' }],
      },
      ...history.map((msg: any) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      }))
    ];

    // Adicionar contexto de dados APENAS no primeiro prompt do usuário
    let messageWithContext = message;
    if (history.length === 0) {
      console.log('🔍 Primeiro prompt detectado - Buscando dados do sistema...');
      const dadosSistema = await analisarDadosDoSistema(userId, userName);

      if (dadosSistema) {
        // Payload otimizado com ATIVIDADES e PEDIDOS
        messageWithContext = `CONTEXTO DO SISTEMA:

👤 Usuário: ${dadosSistema.userName}
📊 Resumo: ${dadosSistema.totalLeads} leads, ${dadosSistema.totalAtividades} atividades, ${dadosSistema.totalPedidos} pedidos (R$ ${(dadosSistema.valorTotalPedidos || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })})

${dadosSistema.totalLeads > 0 ? `💰 LEADS ATIVOS (${dadosSistema.totalLeads}):
${dadosSistema.leads.map((l: any) => `• ${l.NOME} - R$ ${(l.VALOR || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} - ${l.STATUS_LEAD || 'EM_ANDAMENTO'} - Estágio: ${l.CODESTAGIO || 'N/A'}`).join('\n')}` : ''}

${dadosSistema.totalAtividades > 0 ? `📋 ATIVIDADES RECENTES (${dadosSistema.totalAtividades}):
${dadosSistema.atividades.map((a: any) => {
  const desc = a.DESCRICAO?.split('|')[0] || a.DESCRICAO || 'Sem descrição';
  const status = a.STATUS || 'AGUARDANDO';
  const tipo = a.TIPO || '';
  return `• ${desc.substring(0, 50)} - ${tipo} - ${status}`;
}).join('\n')}` : ''}

${dadosSistema.totalPedidos > 0 ? `💵 PEDIDOS RECENTES (${dadosSistema.pedidosRecentes.length} de ${dadosSistema.totalPedidos}):
${dadosSistema.pedidosRecentes.map((p: any) => `• Pedido ${p.NUNOTA} - ${p.NOMEPARC} - R$ ${(parseFloat(p.VLRNOTA) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} - ${p.DTNEG}`).join('\n')}` : ''}

${dadosSistema.totalProdutos > 0 ? `📦 PRODUTOS EM ESTOQUE (${dadosSistema.totalProdutos} disponíveis):
${dadosSistema.produtos.slice(0, 8).map((p: any) => `• ${p.DESCRPROD?.substring(0, 40)} - Estoque: ${parseFloat(p.ESTOQUE || '0').toFixed(0)}`).join('\n')}` : ''}

${dadosSistema.totalParceiros > 0 ? `👥 CLIENTES CADASTRADOS: ${dadosSistema.totalParceiros} clientes disponíveis` : ''}

PERGUNTA DO USUÁRIO:
${message}`;
        console.log('✅ Contexto completo anexado ao prompt (leads, atividades, pedidos)');
      }
    } else {
      console.log('💬 Prompt subsequente - Usando histórico existente');
    }

    const chat = model.startChat({
      history: chatHistory,
    });

    // Usar streaming com contexto
    const result = await chat.sendMessageStream(messageWithContext);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of result.stream) {
            const text = chunk.text();
            const data = `data: ${JSON.stringify({ text })}\n\n`;
            controller.enqueue(encoder.encode(data));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Erro no chat Gemini:', error);
    return new Response(JSON.stringify({ error: 'Erro ao processar mensagem' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}